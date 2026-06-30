# clawfetch

**Languages:** English | [中文说明](README_zh.md)

`clawfetch` is a **web page → markdown scraper CLI** designed primarily for
[OpenClaw](https://github.com/openclaw/openclaw) agents and skills.

It runs especially well inside the patched OpenClaw Docker image
`ernestyu/openclaw-patched`, which ships most of the heavy Playwright
system dependencies and browsers. It can also run in a standard OpenClaw
setup or any Node.js environment **as long as Playwright's system
requirements are satisfied** (see the official Playwright docs for
`npx playwright install-deps`).

Under the hood it uses **Playwright** (headless Chromium), **Mozilla
Readability**, and **Turndown** to turn a single URL into a normalized
markdown document.

- Input: a single `http/https` URL
- Output: normalized markdown to stdout, prefixed with a simple metadata header:

  ```text
  --- METADATA ---
  Title: ...
  Author: ...
  Site: ...
  FinalURL: ...
  Extraction: readability|fallback-container|body-innerText|github-raw-fast-path|reddit-rss
  FallbackSelector: ...   # only when not readability
  --- MARKDOWN ---
  <markdown>
  ```

The design goal is to give OpenClaw (and similar agents) a reliable, agent-
friendly way to ingest web content into local knowledge bases (e.g.
`clawsqlite` / Clawkb) without running a full desktop browser.

## 1. Why clawfetch?

Most "web scraping" approaches tend to fall into two extremes:

1. **Too weak** – simple `curl` + regex/cheerio approaches that only work for static HTML.
   - They often fail completely on JS-heavy sites (WeChat articles, modern blogs, etc.).
2. **Too heavy** – spawning a full desktop browser (Chrome/Firefox GUI) just to read one page.
   - This is wasteful and awkward in Docker/server environments.

`clawfetch` aims for a balance:

- Uses a **headless Chromium** via Playwright, suitable for Docker and CI;
- Uses Readability + Turndown for robust article extraction and markdown output;
- Provides a few **protocol-level fast paths** for special sites (GitHub README, Reddit RSS);
- Focuses on the 90% of pages where you want a reliable article body, not full browser automation.

It is designed **for agents**: instead of just failing with an exit code,
`clawfetch` prints clear `NEXT:` hints on errors so an OpenClaw skill can
decide what to do next (install deps, use git, try RSS, etc.).

## 2. Installation

### 2.1 Install Node.js

Node.js 18+ is recommended (for built-in `fetch` and modern JS features).

### 2.2 Install clawfetch globally

```bash
npm install -g clawfetch
```

### 2.3 Initialize the controlled clawfetch runtime

```bash
clawfetch runtime install
clawfetch runtime check
```

`clawfetch` keeps its Playwright browser binaries in a component-owned runtime
directory under the actual clawfetch package root instead of relying on
whatever Playwright cache happens to exist on the host. It also supports
exactly one Playwright JS runtime shape:
`playwright-core`, installed under the clawfetch package's own `node_modules`
directory and within the version range declared by clawfetch. By default the
browser runtime is:

```text
<clawfetch package root>/.clawfetch-runtime/ms-playwright
```

The package root is the actual npm-installed clawfetch package directory, not
the caller's current working directory. `CLAWFETCH_RUNTIME_DIR` is ignored so
the browser runtime path cannot drift between calls.

---

## 3. Usage

Basic usage:

```bash
clawfetch https://example.com/some-article > article.md
```

Options:

```text
clawfetch <url> [--max-comments N] [--no-reddit-rss] [--auto-install]
clawfetch runtime <status|install|check|repair|upgrade|clean|diagnose>
```

- `--help`            – show help and exit
- `--max-comments N`  – limit number of Reddit comments (0 = no limit; default 50)
- `--no-reddit-rss`   – disable Reddit RSS fast-path and use browser scraping instead
- `--auto-install`    – when dependencies are missing, attempt a local `npm install` in the clawfetch directory

> NOTE: By default, `clawfetch` **does not** install dependencies automatically.
> It only prints clear `npm install` suggestions. Auto-install is opt-in via `--auto-install`.

Runtime lifecycle commands:

- `clawfetch runtime status` shows the clawfetch version, supported Playwright
  package model, actual Playwright package source/version, controlled browser
  path under the package root, manifest match, and whether the expected
  Chromium binary exists.
- `clawfetch runtime install` installs the Chromium runtime for the current
  supported `playwright-core` package.
- `clawfetch runtime check` verifies that the controlled runtime can actually
  launch Chromium after the JS package, package source, manifest, and browser
  binary all match the supported runtime boundary.
- `clawfetch runtime repair` reinstalls the current runtime when files are
  missing or damaged.
- `clawfetch runtime upgrade` installs the browser runtime expected by the
  currently installed clawfetch/Playwright version after a package upgrade.
- `clawfetch runtime clean` prints a dry-run list of old runtime entries;
  add `--yes` to delete them, or `--all --yes` to reset the package-root
  runtime directory.
- `clawfetch runtime diagnose --json` emits structured diagnostics for agents,
  CI, health checks, and support reports.

In an OpenClaw setting, a typical pattern is:

- Let the skill invoke `clawfetch`;
- If the CLI reports missing dependencies, let the agent surface the `NEXT:`
  suggestion to the operator (for example, repair the clawfetch package
  directory with `npm install` and then run `clawfetch runtime install`), or
  retry with `--auto-install` when appropriate.

---

## 4. Site-specific behaviour

### 4.1 General web pages

For normal sites (news, blogs, docs pages), `clawfetch`:

1. Launches headless Chromium via Playwright;
2. Waits for text content to stabilize;
3. Uses Mozilla Readability to extract the main article body;
4. Falls back to a set of common containers (`article`, `main`, `.content`, etc.) if Readability fails;
5. Finally falls back to `document.body.innerText` if needed;
6. Converts HTML → markdown with Turndown;
7. Prints a METADATA header and MARKDOWN body.

If the extracted content is too short or obviously unreliable, `clawfetch`
logs warnings, debug info (including optional screenshots), and suggests next
steps.

### 4.2 GitHub repositories

For URLs like `https://github.com/owner/repo`, `clawfetch` treats them as
**documentation entry points**:

- It first attempts to fetch a raw README from `raw.githubusercontent.com`
  (e.g. `README.md`, `README_zh.md`).
  - On success:
    - `Extraction: github-raw-fast-path`
    - `FinalURL` is the raw README URL;
    - The MARKDOWN body is the README content.
- If all raw candidates fail, it falls back to browser scraping.

In the METADATA or surrounding text, `clawfetch` also suggests how to explore
the full project:

```text
NOTE:
  This content only covers the repository README.
  To inspect the full project or source code, use git:

    git clone git@github.com:owner/repo.git
    cd repo
```

This keeps `clawfetch` focused on documentation, while leaving code navigation
to git-based tools.

### 4.3 Reddit

For `reddit.com` / `www.reddit.com` / `old.reddit.com` URLs, `clawfetch`:

- **By default** tries the RSS fast-path:
  - Converts `<url>` to `<url>.rss` (e.g. `https://www.reddit.com/r/algotrading/` → `.../algotrading/.rss`);
  - Parses the RSS XML into a **structured markdown view** of the thread:
    - The first item is treated as the main post;
    - Subsequent items are rendered as comments;
    - The number of comments is limited by `--max-comments` (default 50;
      `0` means no limit).
  - Prints `Extraction: reddit-rss`.
- If RSS fails (network errors, non-200 status, malformed XML), it falls back
  to browser scraping.

You can disable the RSS fast-path with `--no-reddit-rss` if you need to debug
or experiment with browser-based scraping on Reddit.

---

## 5. Dependencies & auto-install

`clawfetch` depends on the following npm packages:

- `playwright-core`
- `@mozilla/readability`
- `jsdom`
- `turndown`

At runtime, `clawfetch`:

- Supports only `playwright-core` as the Playwright JS runtime.
- Requires `playwright-core` to resolve from the clawfetch package's own
  `node_modules` boundary, not from an ambient host project, another skill, or
  another global install path.
- Requires the resolved `playwright-core` version to satisfy clawfetch's
  declared dependency range.
- Requires the controlled Chromium runtime and runtime manifest to match the
  current clawfetch component and resolved `playwright-core` package.
- Checks for `@mozilla/readability`, `jsdom`, and `turndown` via `require()`.

`playwright` is not treated as an interchangeable substitute for
`playwright-core`. If the supported package is missing, has the wrong version,
resolves from the wrong source, or does not match the controlled browser
runtime, clawfetch exits with a runtime error instead of trying a fallback
package. Use `clawfetch runtime install`, `repair`, `upgrade`, `clean`, and
`diagnose --json` to bring the component-owned runtime back into a supported
state.

If dependencies are missing **and `--auto-install` is not used**:

- It prints the missing packages and suggested install commands:

  ```text
  ERROR: Missing required npm packages:
    - playwright-core
    - @mozilla/readability
    - jsdom
    - turndown

  NEXT:
    - Install clawfetch dependencies in the package directory:
        npm install
    - Then initialize the controlled browser runtime:
        clawfetch runtime install
  ```

- Then exits with a non-zero status.

If `--auto-install` is provided:

- `clawfetch` will attempt a local `npm install` in the clawfetch package root,
  using the component's own `package.json`.
- If the install fails, it prints the same `NEXT` hints and exits.
- If the install succeeds, it retries loading the dependencies and continues.

This makes the default behaviour safe for automated environments while still
allowing a one-shot bootstrap when explicitly requested.

---

## 6. Agent-friendly error hints

Because `clawfetch` is designed to be used by agents (especially OpenClaw
skills running inside Docker images like `ernestyu/openclaw-patched`), error
outputs include **"NEXT" suggestions** to guide the next action, for example:

- On missing dependencies: suggested `npm install` commands;
- On unreliable extraction: suggestions to try RSS, git clone, or a different tool.

Agents can parse these hints to decide what to do next, rather than only
seeing a raw exit code.

---

## 7. License

This project is licensed under the Apache License 2.0. See `LICENSE` for details.
