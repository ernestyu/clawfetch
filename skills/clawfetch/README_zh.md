# clawfetch Skill

这个目录是面向 OpenClaw/ClawHub 的 `clawfetch` npm CLI 薄层 skill 包装。它不是独立 scraper 项目，也不复制 clawfetch 源码。

## 为什么存在

这个 skill 让 Agent 能把 clawfetch 当成受控工具调用，用于把一般网页、GitHub README 页面和 Reddit 线程转换成适合知识库处理的 markdown。真正的抓取实现、runtime 生命周期、站点策略和错误恢复都仍然只由 clawfetch CLI 负责。

## 安装模型

安装是显式两步：

1. 安装或复制这个 skill wrapper 目录。
2. 在本目录运行 bootstrap：

```bash
cd skills/clawfetch
./bootstrap_deps.sh
```

bootstrap 脚本会把已发布的 `clawfetch` npm 包安装到当前 skill 目录，形成 `node_modules/clawfetch`。它不会执行 `git clone`，不会下载源码树，不会修改全局 npm 状态，不会改系统 PATH，也不会安装无关工具。

默认情况下，脚本跟随项目根目录 `package.json` 中的版本。如果这个 wrapper 被单独分发、读不到项目根目录，则回退到脚本中固定记录的版本。

## 使用方式

bootstrap 之后，通过本地 CLI 调用：

```bash
node node_modules/clawfetch/clawfetch.js https://example.com/article
node node_modules/clawfetch/clawfetch.js https://github.com/owner/repo
node node_modules/clawfetch/clawfetch.js https://www.reddit.com/r/example/comments/...
```

runtime 生命周期命令也必须走 CLI：

```bash
node node_modules/clawfetch/clawfetch.js runtime install
node node_modules/clawfetch/clawfetch.js runtime check
node node_modules/clawfetch/clawfetch.js runtime repair
node node_modules/clawfetch/clawfetch.js runtime upgrade
node node_modules/clawfetch/clawfetch.js runtime diagnose --json
```

skill 层不直接管理 browser runtime。它应该把 CLI 输出的 `NEXT:` 提示展示给 Agent 或操作者，而不是发明另一套恢复路径。

## 边界

这个 skill 不实现抓取逻辑、浏览器启动逻辑、Playwright 包解析、browser runtime 管理、GitHub fast-path、Reddit RSS 处理、FlareSolverr 支持或 markdown 转换。

这个 skill 也不隐藏下载逻辑，不 clone 仓库，不做与抓取无关的文件系统操作，也不作为通用 shell 工具使用。
