# clawfetch（中文说明）

`clawfetch` 是一个 **网页 → Markdown 抓取 CLI 工具**，基于：

- Playwright（无头 Chromium）
- Mozilla Readability（正文抽取）
- Turndown（HTML → Markdown）

它的设计目标是在 **Docker / 无头环境** 下，在“抓取质量”和“资源开销”之间取得平衡：

- 不走简单的 `curl + 正则` 那种极易失败的方案；
- 也不拉起完整桌面浏览器（Firefox/Chrome GUI）浪费资源；
- 对 90% 的常规资讯/博客网页，尽量保证“可用+稳定”；
- 对 GitHub/Reddit 这类特殊站点，提供协议级的快速路径（fast path）。

`clawfetch` 特别适合给 **本地知识库**（例如 clawsqlite / Clawkb）喂数据，也可以单独用作网页转 Markdown 工具。

---

## 安装

### 1. 安装 Node.js

需要 Node.js 18+（自带 `fetch` 和现代 JS 特性）。

### 2. 全局安装 clawfetch

```bash
npm install -g clawfetch
```

### 3. 安装 Chromium 浏览器（如果所在环境尚未安装）

```bash
npx playwright install chromium
```

> 在某些 Docker 镜像（例如 OpenClaw patched image）中，Playwright 浏览器可能已经预装，无需重复安装。

---

## 使用方法

最简单用法：

```bash
clawfetch https://example.com/some-article > article.md
```

命令行参数：

```text
clawfetch <url> [--no-reddit-rss] [--auto-install]
```

- `--help`            显示帮助后退出
- `--no-reddit-rss`   对 Reddit URL 禁用 RSS 快速路径，强制用浏览器抓取
- `--auto-install`    当缺少 npm 依赖时，尝试在 clawfetch 安装目录执行一次本地 `npm install`

> 注意：默认情况下，`clawfetch` **不会自动安装依赖**，只会打印清晰的 `npm install` 提示。
> 只有显式加上 `--auto-install` 时，才会尝试在包目录本地安装缺失依赖。

---

## 站点行为说明

### 1. 一般网页

对于普通网站（新闻、博客、文档页）：

1. 通过 Playwright 启动无头 Chromium；
2. 等待页面文本长度稳定；
3. 使用 Readability 抽取主体内容；
4. 如果 Readability 失败，则尝试一组常见容器选择器（`article` / `main` / `.content` 等）；
5. 再不行则退回 `document.body.innerText`；
6. 使用 Turndown 将 HTML 转成 Markdown；
7. 输出带有 `--- METADATA ---` 头部和 `--- MARKDOWN ---` 正文的结果。

当抓取结果过短或明显不可靠时，`clawfetch` 会输出告警信息以及 Debug 信息（例如截图路径、console 日志），并给出下一步建议。

### 2. GitHub 仓库

对于形如 `https://github.com/owner/repo` 的仓库主页 URL：

- `clawfetch` 默认**优先尝试**从 `raw.githubusercontent.com` 获取 README：
  - `README.md` / `README_zh.md` 等常见文件名；
  - 成功时：
    - `Extraction: github-raw-fast-path`
    - `FinalURL` 为实际的 raw 地址；
    - `--- MARKDOWN ---` 下直接输出 README 原文。
- 如果 raw 路径全部失败，则回退到浏览器抓取模式。

同时，clawfetch 会在输出中给出建议：

- 如果你想深入了解项目或获取完整代码，不建议使用网页抓取；
- 推荐使用 git：

  ```bash
  git clone git@github.com:owner/repo.git
  cd repo
  ```

这符合“网页抓取用于文档入口，代码分析交给 git 工具”的职责划分。

### 3. Reddit

对于 `reddit.com` / `www.reddit.com` / `old.reddit.com` 等域名：

- 默认行为：
  - 优先尝试将 URL 直接转为 `.rss`（例如 `https://www.reddit.com/r/algotrading/` → `https://www.reddit.com/r/algotrading/.rss`）；
  - 拉取 RSS XML，解析并将多个帖子合并为 Markdown 列表；
  - 输出 `Extraction: reddit-rss`；
- 如果 RSS 请求失败或内容异常，则退回浏览器抓取模式。

你可以通过 `--no-reddit-rss` 明确关闭 RSS 快速路径，强制使用浏览器模式（仅在调试或特殊需求时推荐）。

---

## 依赖与自动安装

`clawfetch` 依赖以下 npm 包（正常 `npm install` 会自动安装）：

- `playwright-core`（或 `playwright`）
- `@mozilla/readability`
- `jsdom`
- `turndown`

运行时行为：

- 首先尝试 `require("playwright-core")`，失败则尝试 `require("playwright")`；
- 对其它依赖逐个 `require` 检测；
- 如果检测到缺失且 **没有** 使用 `--auto-install`：
  - 打印缺失列表以及推荐的安装命令；
  - 退出并返回非零状态码；
- 如果加了 `--auto-install`：
  - 会在 `clawfetch.js` 所在目录执行一次：

    ```bash
    npm install <缺失的包>
    ```

  - 如果安装失败，同样给出明确的 `npm install` 建议让操作者处理。

此设计是为了适配自动化环境（尤其是 OpenClaw / Agent），**默认不在背后偷偷安装依赖**，而是给出可执行的下一步指令。

---

## 与 Agent / OpenClaw 的配合

`clawfetch` 的错误输出会尽量包含“下一步建议”，例如：

- 缺少依赖时，建议执行哪些 `npm install`；
- 抓取结果不可靠时，建议改用 RSS / git clone / 其它手段；

方便上层 Agent（例如 OpenClaw 的技能）根据这些提示自动选择下一步动作，而不是只得到一个简单的错误码。

---

## 许可证

本项目使用 Apache License 2.0 开源，详情见 `LICENSE`。
