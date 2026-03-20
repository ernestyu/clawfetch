# clawfetch

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
  Extraction: readability|fallback-container|body-innerText|github-raw-fast-path
  FallbackSelector: ...   # only when not readability
  --- MARKDOWN ---
  <markdown>
  ```

It is primarily intended to feed local knowledge bases (e.g. clawsqlite / Clawkb) but can also be used standalone.

## Installation

1. Install Node.js 18+ (for built-in `fetch` and modern JS features).
2. Install the package globally via npm:

   ```bash
   npm install -g clawfetch
   ```

3. Install a Chromium browser for Playwright (if you are not running inside an image that already has it):

   ```bash
   npx playwright install chromium
   ```

This makes the `clawfetch` command available on your `PATH`.

## Usage

Basic usage:

```bash
clawfetch https://example.com/some-article > article.md
```

Options:

- `--help`               – show help and exit
- `--github-readme`      – for GitHub URLs, prefer the raw README fast‑path instead of browser scraping

Behavior:

- For normal web pages:
  - Launches Chromium via Playwright;
  - Waits for text content to stabilize;
  - Uses Mozilla Readability to extract the main article body;
  - Falls back to a set of common content containers if Readability fails;
  - Converts HTML → Markdown with Turndown and prints the result.
- For GitHub URLs with `--github-readme`:
  - Attempts to fetch a raw README file directly from `raw.githubusercontent.com` (main/master variants),
    falling back to browser scraping if this fast‑path fails.

If required Node dependencies are missing, `clawfetch` prints clear installation instructions and exits with a non‑zero code.

## Environment & Dependencies

`clawfetch` depends on the following npm packages (installed automatically via `npm install`):

- `playwright-core` – browser automation (Chromium)
- `@mozilla/readability` – article extraction
- `jsdom` – DOM implementation for Readability
- `turndown` – HTML → Markdown converter

At runtime, `clawfetch` will:

- Prefer `playwright-core` when available;
- Fall back to `playwright` if `playwright-core` is not installed;
- Emit an explicit error message with `npm install` hints if neither is present.

## License

This project is licensed under the Apache License 2.0. See `LICENSE` for details.
