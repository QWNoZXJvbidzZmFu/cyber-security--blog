# 项目约定

这是一个 Hexo 博客（butterfly 主题），部署到 GitHub Pages。

## 目录命名

- **内容目录一律用中文**：`source/图片`、`source/样式`、`source/标签`、`source/分类`、`模板`。
- 以后新增目录也用中文，例如 `source/图片/作业配图/`。
- 下面这些名字是 Hexo / Node 写死的，**不要改成中文**，否则构建会失败：
  `source`、`source/_posts`、`themes`、`scripts`、`node_modules`、`public`、
  `.deploy_git`、`.github`。
- 文章放在 `source/_posts/`（目录名不能改），图片放在 `source/图片/`。

## 写文章

- front-matter 用多行格式；`date` 必须是 `YYYY-MM-DD HH:mm:ss`，
  不要写 `2026:10.26` 这类非法格式。
- 图片引用（三选一，推荐前两种）：
  - Markdown：`![说明](/图片/xxx.png)`，Hexo 会自动补站点根路径 `/cyber-security--blog/`。
  - Obsidian：`![[xxx.png]]` 或 `![[xxx.png|435]]`，由 `scripts/obsidian.js` 解析。
  - 原始 HTML `<img>` 不会自动补根路径，必须写 `/cyber-security--blog/图片/xxx.png`。
- 分类、标签用中文。

## 构建与发布

- 构建：`npx hexo clean && npx hexo generate`，输出到 `public/`。
- 发布：`./publish.sh 文章.md`（自动 clean + generate + deploy）。
- 改完配置或插件后先 `npx hexo clean`，否则 Hexo 会用旧缓存。

## 注意

- `themes/butterfly` 是主题仓库，尽量只改它的 `_config.yml`。
- 不要删除 `.deploy_git/`（部署缓存）。
- 改目录名时，要同步更新 `_config.yml`、`themes/butterfly/_config.yml`、
  `scripts/obsidian.js`、`publish.sh` 和 `如何发布博客.md` 里的路径。
