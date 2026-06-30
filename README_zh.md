# clawfetch（中文说明）

`clawfetch` 是一个 **网页 → markdown 抓取 CLI 工具**，主要是为
[OpenClaw](https://github.com/openclaw/openclaw) 的 Agent / Skill 场景设计的。

它在补丁版 OpenClaw Docker 镜像 `ernestyu/openclaw-patched` 中体验最佳，
该镜像已经预装了大部分 Playwright 运行所需的系统依赖和浏览器。
在**其他** OpenClaw / Node.js 环境中使用时，需要额外确保 Playwright 的
系统依赖已满足（参见官方文档中的 `npx playwright install-deps`）。

底层依赖：

- Playwright（无头 Chromium）
- Mozilla Readability（正文抽取）
- Turndown（HTML → markdown）
- 可选：FlareSolverr（Cloudflare / bot 挑战页面的 JS 抓取后端，优先通过 `clawfetch.toml` 配置）

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

### 3. 初始化 clawfetch 受控运行时

```bash
clawfetch runtime install
clawfetch runtime check
```

`clawfetch` 会把自己的 Playwright 浏览器二进制放在组件专属 runtime 目录中，
这个目录位于当前实际安装的 clawfetch 包根目录内，不再依赖宿主环境里碰巧存在的
Playwright 浏览器缓存。同时，`clawfetch` 只支持一种 Playwright JS runtime
形态：安装在 clawfetch 包自身 `node_modules` 边界内、且版本满足 clawfetch
声明范围的 `playwright-core`。浏览器 runtime 默认位置：

```text
<clawfetch package root>/.clawfetch-runtime/ms-playwright
```

这里的包根目录指 npm 安装后的 clawfetch 实际安装体所在目录，不是调用方当前工作目录。
`CLAWFETCH_RUNTIME_DIR` 会被忽略，避免不同调用之间出现 browser runtime 路径漂移。

---

## 使用方法

最简单用法：

```bash
clawfetch https://example.com/some-article > article.md
```

命令行参数：

```text
clawfetch <url> [--max-comments N] [--no-reddit-rss] [--auto-install]
clawfetch runtime <status|install|check|repair|upgrade|clean|diagnose>
```

- `--help`            显示帮助后退出
- `--max-comments N`  限制 Reddit 评论数量（0 = 不限制；默认 50）
- `--no-reddit-rss`   对 Reddit URL 禁用 RSS 快速路径，强制用浏览器抓取
- `--via-flaresolverr` 强制本次 URL 通过 FlareSolverr 抓取
- `--flaresolverr-url URL` 覆盖 `clawfetch.toml` 中的 `[flaresolverr].url`
- `--flaresolverr-timeout-ms N` 覆盖 `[flaresolverr].max_timeout_ms`
- `--auto-install`    当缺少 npm 依赖时，尝试在 clawfetch 安装目录执行一次本地 `npm install`

> 注意：默认情况下，`clawfetch` **不会自动安装依赖**，只会打印清晰的
> `npm install` 提示。只有显式加上 `--auto-install` 时，才会尝试在包目录本地安装缺失依赖。

运行时生命周期命令：

- `clawfetch runtime status`：查看 clawfetch 版本、受支持的 Playwright 包模型、
  实际解析到的 Playwright 包来源/版本、包根目录内的受控浏览器路径、
  manifest 匹配状态，以及预期 Chromium 二进制是否存在。
- `clawfetch runtime install`：为当前受支持的 `playwright-core` 包安装对应 Chromium runtime。
- `clawfetch runtime check`：在 JS 包类型、包来源、包版本、manifest、浏览器二进制
  都符合受支持 runtime 边界后，实际启动一次 Chromium 验证健康状态。
- `clawfetch runtime repair`：当文件缺失或损坏时，重新安装当前 runtime。
- `clawfetch runtime upgrade`：在升级 clawfetch/Playwright 包后，安装当前版本期望的浏览器 runtime。
- `clawfetch runtime clean`：默认输出旧 runtime 条目的 dry-run 清单；
  加 `--yes` 才会删除，加 `--all --yes` 可以完全重置包根目录内的 runtime。
- `clawfetch runtime diagnose --json`：输出结构化诊断信息，方便 Agent、CI、
  健康检查和远程排障读取。

在 OpenClaw 场景中，典型使用方式是：

- Skill 调用 `clawfetch` 抓取网页；
- 如果 CLI 提示缺少依赖，上层 Agent 可以把 `NEXT:` 段里的命令展示给运维，
  让人类在 clawfetch 包根目录内执行 `npm install` 并随后运行
  `clawfetch runtime install`，或者在合适的时候用 `--auto-install` 再试一次。

---

## 配置文件

`clawfetch` 使用由 CLI 安装边界推导出的固定配置路径。在 OpenClaw /
ClawHub skill 分发场景中，主配置文件固定为：

```text
skills/clawfetch/clawfetch.toml
```

这个文件属于 skill 宿主目录，安装 skill 后即存在。它不放在
`skills/clawfetch/node_modules/clawfetch` 中，因为后者是 bootstrap 后生成的
npm 包安装产物，升级、重装或修复时可能被替换，不适合作为长期维护入口。

默认配置：

```toml
[flaresolverr]
enabled = false
# url = "http://127.0.0.1:8191"
max_timeout_ms = 60000
```

路径规则：

- 当 CLI 从 `skills/clawfetch/node_modules/clawfetch/clawfetch.js` 运行时，
  只读取 `skills/clawfetch/clawfetch.toml`；
- 更一般地说，当 `clawfetch` 安装在某个 `node_modules` 下时，宿主配置文件
  是该 `node_modules` 同级目录里的 `clawfetch.toml`；
- 直接从源码 checkout 运行时，期望配置文件位于组件根目录的
  `clawfetch.toml`；
- 调用方当前工作目录不会参与向上查找；
- FlareSolverr 字段缺失时使用默认值，但 `enabled = true` 时必须有可用 URL。

优先级：

1. CLI 参数：`--flaresolverr-url`、`--flaresolverr-timeout-ms`
2. 固定宿主配置：`skills/clawfetch/clawfetch.toml`
3. `FLARESOLVERR_URL` 作为兼容旧流程和临时覆盖
4. 默认不启用 FlareSolverr

`FLARESOLVERR_URL` 仍然兼容，但新的 skill 安装应优先维护固定位置的
`skills/clawfetch/clawfetch.toml`。如需启用 FlareSolverr，请显式把
`enabled` 改为 `true`，并填入可访问的 `url`。

---

## Cloudflare / bot 挑战站点支持

对于带有 Cloudflare 或类似 bot 挑战的站点（例如 Kaggle 部分页面），
clawfetch 可以调用兼容 FlareSolverr API 的服务。

显式模式：

```bash
clawfetch --via-flaresolverr 'https://www.kaggle.com/.../some-article'
```

自动 fallback：

- 普通浏览器抓取检测到 bot-block 页面时，如果 `[flaresolverr].enabled = true`
  且 URL 有效，会自动尝试用 FlareSolverr 返回的 HTML 重新抽取；
- 如果没有配置 FlareSolverr，错误提示会优先引导配置 `clawfetch.toml`，
  `FLARESOLVERR_URL` 只作为临时兼容选项出现。

Docker 场景中可以使用服务名：

```toml
[flaresolverr]
enabled = true
url = "http://flaresolverr:8191"
max_timeout_ms = 60000
```

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

- `playwright-core`
- `@mozilla/readability`
- `jsdom`
- `turndown`

运行时行为：

- 只支持 `playwright-core` 作为 Playwright JS runtime；
- 要求 `playwright-core` 从 clawfetch 包自身的 `node_modules` 边界内解析，
  不能来自宿主项目、其它 skill、其它全局安装路径或偶然命中的外部依赖；
- 要求解析到的 `playwright-core` 版本满足 clawfetch 声明的依赖范围；
- 要求受控 Chromium runtime 与当前 clawfetch 组件、当前 `playwright-core`
  包以及 runtime manifest 保持一致；
- 对其它依赖逐个 `require` 检测；
- 如果检测到缺失且 **没有** 使用 `--auto-install`：
  - 打印缺失列表以及推荐的安装命令；
  - 退出并返回非零状态码；
- 如果加了 `--auto-install`：
  - 会在 clawfetch 包根目录执行一次：

    ```bash
    npm install
    ```

  - 安装内容由组件自己的 `package.json` 决定；
  - 如果安装失败，同样给出明确的 `npm install` 建议让操作者处理。

`playwright` 不再被视为 `playwright-core` 的等价替代品。如果受支持包缺失、
版本不符、来源不符，或与受控浏览器 runtime 不匹配，`clawfetch` 会直接报
runtime 错误，不会自动尝试其它包。请通过 `clawfetch runtime install` /
`repair` / `upgrade` / `clean` / `diagnose --json` 把组件自己的 runtime
修复到受支持状态。

此设计是为了适配自动化环境（尤其是 OpenClaw / Agent），**默认不在背后偷偷安装依赖**，
而是给出可执行的下一步指令；对于基础组件，确定性比自动 fallback 更重要。

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
