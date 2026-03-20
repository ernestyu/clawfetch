# clawfetch

**Languages:** English | [中文说明](README_zh.md)

Web page → Markdown scraper CLI built on **Playwright**, **Readability**, and **Turndown**.

`clawfetch` is designed as a small, composable tool:

- Input: a single `http/https` URL
- Output: normalized Markdown to stdout, prefixed with a simple metadata header:

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

It is primarily intended to feed local knowledge bases (e.g. clawsqlite / Clawkb) but can also be used standalone.

## 1. Why clawfetch?

Most "web scraping" approaches tend to fall into two extremes:

1. **Too weak** – simple `curl` + regex/cheerio approaches that only work for static HTML.
   - They often fail completely on JS-heavy sites (WeChat articles, modern blogs, etc.).
2. **Too heavy** – spawning a full desktop browser (Chrome/Firefox GUI) just to read one page.
   - This is wasteful and awkward in Docker/server environments.

`clawfetch` aims for a balance:

- Uses a **headless Chromium** via Playwright, suitable for Docker and CI;
- Uses Readability + Turndown for robust article extraction and Markdown output;
- Provides a few **protocol-level fast paths** for special sites (GitHub README, Reddit RSS);
- Focuses on the 90% of pages where you want a reliable article body, not full browser automation.

It is designed for agents and tools that need a clean Markdown representation of web pages, especially as input to local SQLite-based knowledge bases.

## 2. Installation

### 2.1 Install Node.js

Node.js 18+ is recommended (for built-in `fetch` and modern JS features).

### 2.2 Install clawfetch globally

```bash
npm install -g clawfetch
```

### 2.3 Install Chromium for Playwright (if needed)

```bash
npx playwright install chromium
```

In some environments (e.g. prebuilt OpenClaw images), Playwright browsers may already be installed.

---

## 3. Usage

Basic usage:

```bash
clawfetch https://example.com/some-article > article.md
```

Options:

```text
clawfetch <url> [--no-reddit-rss] [--auto-install]
```

- `--help`            – show help and exit
- `--no-reddit-rss`   – disable Reddit RSS fast-path and use browser scraping instead
- `--auto-install`    – when dependencies are missing, attempt a local `npm install` in the clawfetch directory

> NOTE: By default, `clawfetch` **does not** install dependencies automatically.
> It only prints clear `npm install` suggestions. Auto-install is opt-in via `--auto-install`.

---

## 4. Site-specific behaviour

### 4.1 General web pages

For normal sites (news, blogs, docs pages), `clawfetch`:

1. Launches headless Chromium via Playwright;
2. Waits for text content to stabilize;
3. Uses Mozilla Readability to extract the main article body;
4. Falls back to a set of common containers (`article`, `main`, `.content`, etc.) if Readability fails;
5. Finally falls back to `document.body.innerText` if needed;
6. Converts HTML → Markdown with Turndown;
7. Prints a METADATA header and MARKDOWN body.

If the extracted content is too short or obviously unreliable, `clawfetch` logs warnings, debug info (including optional screenshots), and suggests next steps.

### 4.2 GitHub repositories

For URLs like `https://github.com/owner/repo`, `clawfetch` treats them as **documentation entry points**:

- It first attempts to fetch a raw README from `raw.githubusercontent.com` (e.g. `README.md`, `README_zh.md`).
  - On success:
    - `Extraction: github-raw-fast-path`
    - `FinalURL` is the raw README URL;
    - The MARKDOWN body is the README content.
- If all raw candidates fail, it falls back to browser scraping.

In the METADATA or surrounding text, `clawfetch` also suggests how to explore the full project:

```text
NOTE:
  This content only covers the repository README.
  To inspect the full project or source code, use git:

    git clone git@github.com:owner/repo.git
    cd repo
```

This keeps `clawfetch` focused on documentation, while leaving code navigation to git-based tools.

### 4.3 Reddit

For `reddit.com` / `www.reddit.com` / `old.reddit.com` URLs, `clawfetch`:

- **By default** tries the RSS fast-path:
  - Converts `<url>` to `<url>.rss` (e.g. `https://www.reddit.com/r/algotrading/` → `.../algotrading/.rss`);
  - Fetches the RSS XML and converts items into Markdown (titles, descriptions, links);
  - Prints `Extraction: reddit-rss`.
- If RSS fails (network errors, non-200 status, malformed XML), it falls back to browser scraping.

You can disable the RSS fast-path with `--no-reddit-rss` if you need to debug or experiment with browser-based scraping on Reddit.

---

## 5. Dependencies & auto-install

`clawfetch` depends on the following npm packages:

- `playwright-core` (or `playwright`)
- `@mozilla/readability`
- `jsdom`
- `turndown`

At runtime, `clawfetch`:

- Prefers `playwright-core` when available; falls back to `playwright`.
- Checks for `@mozilla/readability`, `jsdom`, and `turndown` via `require()`.

If dependencies are missing **and `--auto-install` is not used**:

- It prints the missing packages and suggested install commands:

  ```text
  ERROR: Missing required npm packages:
    - playwright-core (or playwright)
    - @mozilla/readability
    - jsdom
    - turndown

  NEXT:
    - Install globally:
        npm install -g playwright-core @mozilla/readability jsdom turndown
      or locally:
        npm install playwright-core @mozilla/readability jsdom turndown
  ```

- Then exits with a non-zero status.

If `--auto-install` is provided:

- `clawfetch` will attempt a local `npm install` for the missing packages in the clawfetch directory.
- If the install fails, it prints the same `NEXT` hints and exits.
- If the install succeeds, it retries loading the dependencies and continues.

This makes the default behaviour safe for automated environments while still allowing a one-shot bootstrap when explicitly requested.

---

## 6. Agent-friendly error hints

Because `clawfetch` is designed to be used by agents (e.g. OpenClaw skills), error outputs include **"NEXT" suggestions** to guide the next action, for example:

- On missing dependencies: suggested `npm install` commands;
- On unreliable extraction: suggestions to try RSS, git clone, or a different tool.

Agents can parse these hints to decide what to do next, rather than only seeing a raw exit code.

---

## 7. License

This project is licensed under the Apache License 2.0. See `LICENSE` for details.
