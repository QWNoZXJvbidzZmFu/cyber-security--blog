#!/usr/bin/env bash
# 一键发布 Markdown 到博客
# 用法: ./publish.sh 你的文章.md [更多.md ...]
set -euo pipefail

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POSTS_DIR="$SITE_DIR/source/_posts"
SITE_URL="https://qwnozxjvbidzzmfu.github.io/cyber-security--blog/"
# 站点根路径（用于原始 HTML <img>，Markdown 图片会自动补全，不需要）
ROOT_PREFIX="$(sed -n 's/^root:[[:space:]]*//p' "$SITE_DIR/_config.yml" | head -n1 | tr -d '\r')"
[[ "$ROOT_PREFIX" == /* ]] || ROOT_PREFIX="/$ROOT_PREFIX"
[[ "$ROOT_PREFIX" == */ ]] || ROOT_PREFIX="$ROOT_PREFIX/"

slug=""
no_deploy=0
preview=0
force=0
files=()

usage() {
  cat <<'EOF'
用法: ./publish.sh <文章.md> [更多.md ...] [选项]

选项:
  -s, --slug <英文名>   指定 URL 里的文件名（默认用原文件名）
  -f, --force           覆盖 source/_posts 里的同名文章
      --no-deploy       只构建、不推送到 GitHub
      --preview         构建后本地预览（http://localhost:4000）
  -h, --help            显示帮助

示例:
  ./publish.sh ~/Desktop/我的文章.md
  ./publish.sh ~/Desktop/我的文章.md -s my-post
  ./publish.sh ~/Desktop/我的文章.md --preview
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--slug)   slug="${2:-}"; shift 2 ;;
    -f|--force)  force=1; shift ;;
    --no-deploy) no_deploy=1; shift ;;
    --preview)   preview=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    -*)          echo "未知参数: $1" >&2; usage; exit 1 ;;
    *)           files+=("$1"); shift ;;
  esac
done

if [[ ${#files[@]} -eq 0 ]]; then
  usage
  exit 1
fi

if [[ $preview -eq 1 && $no_deploy -eq 0 ]]; then
  echo "提示: --preview 模式下不会自动部署，预览没问题后再运行一次去掉 --preview。"
  no_deploy=1
fi

mkdir -p "$POSTS_DIR"

prepare_one() {
  local src="$1"
  if [[ ! -f "$src" ]]; then
    echo "找不到文件: $src" >&2
    exit 1
  fi
  if [[ "$src" != *.md ]]; then
    echo "只支持 .md 文件: $src" >&2
    exit 1
  fi

  local base
  base="$(basename "$src" .md)"

  # 默认用文件名做 URL；去掉空格和特殊字符，保留中文
  local name="$slug"
  if [[ -z "$name" ]]; then
    name="$base"
  fi
  name="$(printf '%s' "$name" | sed -E 's/[[:space:]]+/-/g; s#[/\\:*?"<>|]#-#g; s/-+/-/g; s/^-|-$//g')"
  if [[ -z "$name" ]]; then
    name="post-$(date +%Y%m%d%H%M%S)"
  fi

  local dest="$POSTS_DIR/$name.md"
  if [[ -e "$dest" && $force -eq 0 ]]; then
    echo "已存在: $dest" >&2
    echo "如果确认要覆盖，加 -f；或者用 -s 指定另一个文件名。" >&2
    exit 1
  fi

  local has_fm=0
  if [[ "$(head -n 1 "$src" | tr -d '\r')" == "---" ]] && \
     sed -n '2,40p' "$src" | tr -d '\r' | grep -qx -- '---'; then
    has_fm=1
  fi

  if [[ $has_fm -eq 1 ]]; then
    cp "$src" "$dest"
    echo "已复制（保留原有 front-matter）: $dest"
  else
    local title
    title="$(grep -m1 -E '^#[[:space:]]+' "$src" | sed -E 's/^#[[:space:]]+//' || true)"
    if [[ -z "$title" ]]; then
      title="$base"
    fi
    {
      printf -- '---\n'
      printf 'title: %s\n' "$title"
      printf 'date: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
      printf 'tags:\n'
      printf -- '---\n\n'
      cat "$src"
    } > "$dest"
    echo "已生成标题/日期并复制: $dest"
  fi

  # 兼容 Obsidian 的 ![[图片]] 写法：自动转成标准 Markdown 并复制图片
  convert_obsidian "$dest" "$(cd "$(dirname "$src")" && pwd)"

  # 提醒：本地图片要放到 source/图片/，文章里用 /图片/xxx.png
  if grep -qE '!\[[^]]*\]\((\./|\.\./|[^/)]+\.(png|jpe?g|gif|webp|svg))' "$dest"; then
    echo "注意: 文章里仍有相对路径图片。请把图片放到 source/图片/，并把引用改成 /图片/文件名。"
  fi
}

# 把 ![[截图.png]] / ![[截图.png|435]] 转成 ![截图](/图片/截图.png) 或 <img width=...>
# 图片会从文章所在目录、attachments/、img/、图片/、assets/ 里找，找到就复制进 source/图片/
convert_obsidian() {
  local md="$1" mddir="$2"
  local refs
  refs="$(grep -oE '!\[\[[^]]+\]\]' "$md" 2>/dev/null || true)"
  [[ -z "$refs" ]] && return 0

  local missing=() ref inner target width srcfile safe repl
  while IFS= read -r ref; do
    [[ -z "$ref" ]] && continue
    inner="${ref#![[}"
    inner="${inner%]]}"
    target="${inner%%|*}"
    width=""
    if [[ "$inner" == *"|"* ]]; then
      width="${inner##*|}"
    fi
    target="$(printf '%s' "$target" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"

    srcfile=""
    local cand
    for cand in "$SITE_DIR/source/图片/$target" "$mddir/$target" \
                "$mddir/attachments/$target" "$mddir/图片/$target" "$mddir/img/$target" "$mddir/assets/$target"; do
      if [[ -f "$cand" ]]; then
        srcfile="$cand"
        break
      fi
    done

    if [[ -z "$srcfile" ]]; then
      missing+=("$target")
      continue
    fi

    # 文件名去掉空格和特殊字符，避免 URL 出问题
    safe="$(printf '%s' "$target" | sed -E 's/[[:space:]]+/-/g; s#[/\\:*?"<>|]#-#g')"
    if [[ "$srcfile" != "$SITE_DIR/source/图片/$safe" ]]; then
      cp -f "$srcfile" "$SITE_DIR/source/图片/$safe"
    fi

    local alt="${target%.*}"
    if [[ -n "$width" && "$width" =~ ^[0-9]+$ ]]; then
      # 原始 HTML 不会被 Markdown 渲染器补全站点根路径，这里手动加上
      repl="<img src=\"${ROOT_PREFIX}图片/$safe\" width=\"$width\" alt=\"$alt\">"
    else
      repl="![$alt](/图片/$safe)"
    fi
    REF="$ref" REPL="$repl" perl -0pi -e 's/\Q$ENV{REF}\E/$ENV{REPL}/g' "$md"
  done <<< "$refs"

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "警告: 这些图片没找到，文章里会显示成文字，请手动放进 source/图片/：" >&2
    printf '  - %s\n' "${missing[@]}" >&2
  fi
}

for f in "${files[@]}"; do
  prepare_one "$f"
done

cd "$SITE_DIR"
echo "==> 清理并生成静态页面"
npx hexo clean
npx hexo generate

if [[ $preview -eq 1 ]]; then
  echo "==> 本地预览: http://localhost:4000/cyber-security--blog/"
  npx hexo server
  exit 0
fi

if [[ $no_deploy -eq 1 ]]; then
  echo "==> 已构建（未部署）。检查 public/ 后运行 npx hexo deploy。"
  exit 0
fi

echo "==> 推送到 GitHub Pages"
npx hexo deploy

echo
echo "完成。等 GitHub Pages 构建（约 1 分钟）后访问:"
echo "  $SITE_URL"
