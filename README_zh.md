# clawfetch（中文说明）

`clawfetch` 是一个 **网页 → markdown 抓取 CLI 工具**，主要是为
[OpenClaw](https://github.com/openclaw/openclaw) 的 Agent / Skill 场景设计的。

它在补丁版 OpenClaw Docker 镜像 `ernestyu/openclaw-patched` 中体验最佳，
也适用于普通 OpenClaw 环境，甚至任何带 Node.js 的环境。

底层依赖：

- Playwright（无头 Chromium）
- Mozilla Readability（正文抽取）
- Turndown（HTML → markdown）

输入：单个 `http/https` URL
输出：标准化的 markdown（写到 stdout），前面带一段简单的元数据头部：

```text
--- METADATA ---
Title: ...
Author: ...
Site: ...
FinalURL: ...
Extraction: readability|fallback-container|body-innerText|github-raw-fast-path|reddit-rss
FallbackSelector: ...   # 仅在非 readability 模式下出现
--- MARKDOWN ---
<markdown>
```

它的设计目标是：为 OpenClaw（以及类似 Agent）提供一种可靠、
**Agent 友好** 的方式，把网页内容转成 markdown，特别适合喂给本地 SQLite
知识库（例如 `clawsqlite` / Clawkb），而又不需要启动完整桌面浏览器。

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

> 在补丁版镜像 `ernestyu/openclaw-patched` 中，Playwright 浏览器通常已预装。

---

## 使用方法

最简单用法：

```bash
clawfetch https://example.com/some-article > article.md
```

命令行参数：

```text
clawfetch <url> [--max-comments N] [--no-reddit-rss]
```

- `--help`            显示帮助后退出
- `--max-comments N`  限制 Reddit 评论数量（0 = 不限制；默认 50）
- `--no-reddit-rss`   对 Reddit URL 禁用 RSS 快速路径，强制用浏览器抓取

当缺少 npm 依赖时，`clawfetch` 的行为是：

- 打印缺失包列表；
- 打印推荐的 `npm install` 命令（全局或本地）；
- 返回非零状态码退出。

CLI 本身不会在运行时隐式执行 `npm install`，便于在 Agent 环境中审计和控制
依赖安装行为。

---

## 站点行为说明

### 1. 一般网页

对于普通网站（新闻、博客、文档页）：

1. 通过 Playwright 启动无头 Chromium；
2. 等待页面文本长度稳定；
3. 使用 Readability 抽取主体内容；
4. 如果 Readability 失败，则尝试一组常见容器选择器（`article` / `main` / `.content` 等）；
5. 再不行则退回 `document.body.innerText`；
6. 使用 Turndown 将 HTML 转成 markdown；
7. 输出带有 `--- METADATA ---` 头部和 `--- MARKDOWN ---` 正文的结果。

当抓取结果过短或明显不可靠时，`clawfetch` 会输出告警信息以及 Debug
信息（例如截图路径、console 日志），并给出下一步建议。

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
  - 优先尝试将 URL 直接转为 `.rss`（例如
    `https://www.reddit.com/r/algotrading/` →
    `https://www.reddit.com/r/algotrading/.rss`）；
  - 将 RSS XML 解析成一个**结构化的 thread 视图**：
    - 第一个 item 作为主帖；
    - 后续 items 作为评论；
    - 评论数量受到 `--max-comments` 限制（默认 50，传入 0 表示不限制）；
  - 输出 `Extraction: reddit-rss`；
- 如果 RSS 请求失败或内容异常，则退回浏览器抓取模式。

你可以通过 `--no-reddit-rss` 明确关闭 RSS 快速路径，强制使用浏览器模式（仅在调试或特殊需求时推荐）。

---

## 依赖与自动安装

`clawfetch` 依赖以下 npm 包：

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

`clawfetch` 非常适合配合 OpenClaw 的 Docker 镜像使用，尤其是
`ernestyu/openclaw-patched`；在普通 OpenClaw 部署中，只要安装好 Node
和上述依赖，也可以直接使用。

---

## 许可证

本项目使用 Apache License 2.0 开源，详情见 `LICENSE`。
