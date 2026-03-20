#!/usr/bin/env node
"use strict";

// clawfetch - web page → markdown scraper CLI
//
// Playwright + Readability + Turndown based scraper that takes a single URL
// and emits normalized markdown with a small metadata header.
//
//   --- METADATA ---
//   Title: ...
//   Author: ...
//   Site: ...
//   FinalURL: ...
//   Extraction: readability|fallback-container|body-innerText|github-raw-fast-path|reddit-rss
//   FallbackSelector: ...   # only when not readability
//   --- MARKDOWN ---
//   <markdown>
//
// Dependencies are resolved at runtime with basic checks:
// - Prefer playwright-core; fall back to playwright if needed.
// - If required npm packages are missing, print installation hints and exit.

const { spawnSync } = require("child_process");
const { JSDOM } = require("jsdom");

const argv = process.argv.slice(2);

function printHelp() {
  console.log("clawfetch - web page → markdown scraper\n");
  console.log("Usage:");
  console.log("  clawfetch <url> [--max-comments N] [--no-reddit-rss]\n");
  console.log("Options:");
  console.log("  --help            Show this help and exit");
  console.log("  --max-comments N  Limit number of Reddit comments (0 = no limit; default 50)");
  console.log("  --no-reddit-rss   Disable Reddit RSS fast-path and use browser scraping\n");
}

if (argv.includes("--help") || argv.length === 0) {
  printHelp();
  process.exit(argv.length === 0 ? 1 : 0);
}

let url = null;
const flags = new Set();
let maxComments = 50; // default for Reddit RSS comments (0 = no limit)

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("-")) {
    if (!url) url = a;
    continue;
  }

  if (a === "--max-comments") {
    const v = argv[i + 1];
    if (v && !v.startsWith("-")) {
      const parsed = parseInt(v, 10);
      if (!Number.isNaN(parsed)) {
        maxComments = parsed;
      }
      i += 1; // skip value
    }
  } else {
    flags.add(a);
  }
}

if (!url || !/^https?:\/\//i.test(url)) {
  console.error("ERROR: Invalid arguments – please provide a valid http/https URL as the first non-flag argument.");
  console.error(
    "NEXT:\n" +
      "  - Ensure the URL starts with http:// or https://\n" +
      "  - Example:\n" +
      "      clawfetch https://example.com\n"
  );
  process.exit(2);
}

const disableRedditRss = flags.has("--no-reddit-rss");

function loadDeps() {
  const missing = [];

  let chromium;
  try {
    ({ chromium } = require("playwright-core"));
  } catch (e1) {
    try {
      ({ chromium } = require("playwright"));
    } catch (e2) {
      missing.push("playwright-core (or playwright)");
    }
  }

  let Readability;
  try {
    ({ Readability } = require("@mozilla/readability"));
  } catch {
    missing.push("@mozilla/readability");
  }

  let TurndownService;
  try {
    TurndownService = require("turndown");
  } catch {
    missing.push("turndown");
  }

  if (missing.length > 0) {
    console.error("ERROR: Missing required npm packages:\n  - " + missing.join("\n  - "));
    console.error(
      "\nNEXT:\n" +
        "  - Install globally:\n" +
        "      npm install -g playwright-core @mozilla/readability jsdom turndown\n" +
        "    or locally:\n" +
        "      npm install playwright-core @mozilla/readability jsdom turndown\n"
    );
    process.exit(1);
  }

  return { chromium, Readability, TurndownService };
}

const { chromium, Readability, TurndownService } = loadDeps();

function nowIso() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function waitForStableText(
  page,
  { minLen = 800, stableRounds = 3, intervalMs = 700, timeoutMs = 30000 } = {}
) {
  const start = Date.now();
  let lastLen = 0;
  let stable = 0;

  while (Date.now() - start < timeoutMs) {
    const len = await page.evaluate(
      () =>
        document.body && document.body.innerText
          ? document.body.innerText.length
          : 0
    );

    if (len >= minLen && Math.abs(len - lastLen) < 30) {
      stable += 1;
      if (stable >= stableRounds) return len;
    } else {
      stable = 0;
    }

    lastLen = len;
    await page.waitForTimeout(intervalMs);
  }

  return await page.evaluate(
    () =>
      document.body && document.body.innerText
        ? document.body.innerText.length
        : 0
  );
}

async function smartAutoScroll(
  page,
  { maxSteps = 40, stepPx = 700, delayMs = 80, maxMs = 12000 } = {}
) {
  const start = Date.now();
  let lastHeight = await page.evaluate(() => document.body.scrollHeight);
  let stagnantRounds = 0;

  for (let i = 0; i < maxSteps; i++) {
    if (Date.now() - start > maxMs) break;

    await page.evaluate((y) => window.scrollBy(0, y), stepPx);
    await page.waitForTimeout(delayMs);

    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h <= lastHeight + 10) {
      stagnantRounds += 1;
      if (stagnantRounds >= 5) break;
    } else {
      stagnantRounds = 0;
    }
    lastHeight = h;
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
}

function buildTurndown() {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
  });

  td.addRule("fencedCodeBlock", {
    filter: function (node) {
      return node.nodeName === "PRE";
    },
    replacement: function (content, node) {
      const codeNode = node.querySelector("code");
      const code = (codeNode ? codeNode.textContent : node.textContent) || "";
      const cleaned = code.replace(/\n+$/, "");
      return "\n\n```" + "\n" + cleaned + "\n```" + "\n\n";
    },
  });

  td.addRule("images", {
    filter: "img",
    replacement: function (content, node) {
      const alt = (node.getAttribute("alt") || "").trim();
      const src = (node.getAttribute("src") || "").trim();
      if (!src) return "";
      return `![${alt}](${src})`;
    },
  });

  td.addRule("links", {
    filter: "a",
    replacement: function (content, node) {
      const href = (node.getAttribute("href") || "").trim();
      const text = (content || node.textContent || "").trim() || href;
      if (!href) return text;
      return `[${text}](${href})`;
    },
  });

  td.keep(["table", "thead", "tbody", "tr", "th", "td"]);

  return td;
}

function sanitizeDom(document, baseUrl) {
  const remove = (sel) =>
    document.querySelectorAll(sel).forEach((n) => n.remove());

  remove("script, style, noscript, iframe");
  remove("header nav, footer, .footer, .nav, .navbar, .header, .ads, .advertisement");

  document.querySelectorAll("img").forEach((img) => {
    const candidates = [
      img.getAttribute("data-src"),
      img.getAttribute("data-original"),
      img.getAttribute("data-url"),
      img.getAttribute("data-actualsrc"),
      img.getAttribute("data-lazy-src"),
    ].filter(Boolean);

    if (!img.getAttribute("src") && candidates.length > 0) {
      img.setAttribute("src", candidates[0]);
    }
  });

  const base = (baseUrl || (document && document.baseURI) || "").trim();

  const toAbs = (raw) => {
    const v = (raw || "").trim();
    if (/^(javascript:|mailto:|tel:)/i.test(v)) return v;
    if (v.startsWith("#")) return v;
    try {
      if (!base) return v;
      return new URL(v, base).toString();
    } catch (e) {
      return v;
    }
  };

  document.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    const abs = toAbs(href);
    if (abs && abs !== href) a.setAttribute("href", abs);
  });

  document.querySelectorAll("img[src]").forEach((img) => {
    const src = img.getAttribute("src");
    const abs = toAbs(src);
    if (abs && abs !== src) img.setAttribute("src", abs);
  });
}

function pickFallbackContainerHtml(document) {
  const selectors = [
    "#js_content",
    "article",
    "main",
    "[role=\"main\"]",
    ".content",
    ".post",
    ".entry-content",
    ".article-content",
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent && el.textContent.trim().length > 200) {
      return { html: el.innerHTML, selector: sel };
    }
  }

  return {
    html: document.body ? document.body.innerHTML : "",
    selector: "document.body",
  };
}

async function tryGithubReadmeFastPath(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return false;
  }

  const host = parsed.hostname || "";
  if (!host.includes("github.com")) return false;

  if (urlStr.includes("raw.githubusercontent.com")) return false;

  let rawUrl = urlStr
    .replace("github.com", "raw.githubusercontent.com")
    .replace("/blob/", "/")
    .replace("/tree/", "/");

  let targetUrls = [rawUrl];
  if (!rawUrl.split("/").pop().includes(".")) {
    const base = rawUrl.replace(/\/$/, "");
    targetUrls = [
      `${base}/main/README.md`,
      `${base}/master/README.md`,
      `${base}/main/README.zh-CN.md`,
      `${base}/main/README_zh.md`,
    ];
  }

  for (const u of targetUrls) {
    try {
      const response = await fetch(u, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const text = await response.text();
        console.log("--- METADATA ---");
        console.log(`Title: GitHub Raw - ${urlStr}`);
        console.log("Author: N/A");
        console.log("Site: GitHub");
        console.log(`FinalURL: ${u}`);
        console.log("Extraction: github-raw-fast-path");
        console.log("--- MARKDOWN ---");
        console.log(text);
        return true;
      }
    } catch (e) {
      // ignore and try next
    }
  }

  console.error("WARN: GitHub README fast-path failed, falling back to browser mode.");
  console.error(
    "NEXT:\n" +
      "  - Use git if you need full repository context:\n" +
      `      git clone git@github.com:${parsed.pathname.replace(/^\//, "").split("/").slice(0, 2).join("/")}.git\n` +
      "      cd <repo-name>\n"
  );
  return false;
}

async function tryRedditRssFastPath(urlStr, TurndownSvc, maxCommentsOpt) {
  if (disableRedditRss) return false;

  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return false;
  }

  const host = parsed.hostname || "";
  if (!/\.reddit\.com$/.test(host) && host !== "reddit.com") {
    return false;
  }

  let rssUrl = parsed.toString();
  if (!rssUrl.endsWith(".rss")) {
    rssUrl = rssUrl.replace(/\/$/, "") + ".rss";
  }

  try {
    const response = await fetch(rssUrl, {
      signal: AbortSignal.timeout(5000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Accept: "application/atom+xml, text/xml, */*;q=0.9",
      },
    });
    if (!response.ok) {
      console.error(
        `WARN: Reddit RSS request failed with status ${response.status}, falling back to browser mode.`
      );
      console.error(
        "NEXT:\n  - Try again later or let an operator inspect the URL directly in a browser.\n"
      );
      return false;
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("xml") && !contentType.includes("rss")) {
      console.error(
        `WARN: Reddit RSS response is not XML (content-type=${contentType || "unknown"}), falling back to browser mode.`
      );
      console.error(
        "NEXT:\n  - This may be a network block or HTML error page. Try again later or use browser mode.\n"
      );
      return false;
    }

    const xml = await response.text();

    // Detect common HTML/network block pages masquerading as RSS
    if (xml.includes("You've been blocked by network security.")) {
      console.error(
        "WARN: Reddit RSS appears to be a network security block page, falling back to browser mode."
      );
      console.error(
        "NEXT:\n  - RSS is blocked in this environment. Use browser mode or run clawfetch from a network without this block.\n"
      );
      return false;
    }

    const dom = new JSDOM(xml, { contentType: "text/xml", url: rssUrl });
    const doc = dom.window.document;

    // Support both RSS 2.0 (<channel><item>) and Atom (<feed><entry>)
    const feedEl = doc.querySelector("feed");
    const channelEl = doc.querySelector("channel");
    let itemNodes = Array.from(doc.querySelectorAll("item"));
    let entryNodes = Array.from(doc.querySelectorAll("entry"));

    const isAtom = !!feedEl && entryNodes.length > 0;
    const items = isAtom ? entryNodes : itemNodes;

    if ((!channelEl && !feedEl) || items.length === 0) {
      console.error(
        "WARN: Reddit RSS/Atom response did not contain a valid channel/feed structure with items/entries, falling back to browser mode."
      );
      console.error(
        "NEXT:\n  - This may be an HTML error/blocked page instead of RSS. Try again later or use browser mode.\n"
      );
      return false;
    }

    const channelTitle = isAtom
      ? (feedEl.querySelector("title") || {}).textContent || "Reddit RSS"
      : (channelEl.querySelector("title") || {}).textContent || "Reddit RSS";
    const site = host;

    const turndown = new TurndownSvc();

    let bodyMd = "";
    if (items.length > 0) {
      const parts = [];

      const fmtTime = (t) => {
        if (!t) return "";
        return t.replace(/T/, " ");
      };

      const limit = maxCommentsOpt == null ? 50 : maxCommentsOpt;
      const maxIdx = limit < 0 ? Infinity : limit;

      items.forEach((item, idx) => {
        const title = (item.querySelector("title") || {}).textContent || "(no title)";
        const link = (item.querySelector("link") || {}).textContent || "";
        const pubDateNode = item.querySelector("updated, pubDate");
        const pubDate = pubDateNode && pubDateNode.textContent ? pubDateNode.textContent : "";

        // Author: Atom (<author><name>) vs RSS (<author>/<creator>/dc:creator)
        let author = "N/A";
        if (isAtom) {
          const nameEl = item.querySelector("author > name");
          if (nameEl && nameEl.textContent) author = nameEl.textContent;
        } else {
          const authorNode = item.querySelector("author, creator, dc\\:creator");
          if (authorNode && authorNode.textContent) author = authorNode.textContent;
        }

        // Body: Atom uses <content type="html">, RSS uses <description>
        const descNode = isAtom
          ? item.querySelector("content")
          : item.querySelector("description");
        let descMd = "";
        if (descNode && descNode.textContent) {
          // description is HTML; extract Reddit's markdown container(s) when present
          const descHtml = descNode.textContent;
          let innerHtml = descHtml;
          try {
            const innerDom = new JSDOM(descHtml, { contentType: "text/html" });
            const mdDivs = innerDom.window.document.querySelectorAll("div.md");
            if (mdDivs.length > 0) {
              innerHtml = Array.from(mdDivs)
                .map((d) => d.innerHTML)
                .join("<hr/>");
            } else if (innerDom.window.document.body) {
              innerHtml = innerDom.window.document.body.innerHTML;
            }
          } catch {
            // fall back to raw description HTML
            innerHtml = descHtml;
          }
          descMd = turndown.turndown(innerHtml);
        }

        if (idx === 0) {
          parts.push(
            "## Post: " + title + "\n" +
              (author !== "N/A" || pubDate
                ? `by ${author !== "N/A" ? author : "(unknown)"}${pubDate ? " at " + fmtTime(pubDate) : ""}\n\n`
                : "") +
              descMd +
              (link ? `\n\n[link](${link})` : "")
          );
        } else if (idx <= maxIdx || maxIdx === Infinity) {
          parts.push(
            "### Comment by " + (author !== "N/A" ? author : "(unknown)") +
              (pubDate ? " at " + fmtTime(pubDate) : "") +
              "\n\n" +
              descMd
          );
        }
      });

      bodyMd = parts.join("\n\n---\n\n");
    } else {
      bodyMd = turndown.turndown(xml);
    }

    console.log("--- METADATA ---");
    console.log(`Title: ${channelTitle}`);
    console.log(`Author: N/A`);
    console.log(`Site: ${site}`);
    console.log(`FinalURL: ${rssUrl}`);
    console.log("Extraction: reddit-rss");
    console.log("--- MARKDOWN ---");
    console.log(bodyMd);
    return true;
  } catch (e) {
    console.error(`WARN: Reddit RSS fast-path failed: ${e.message}. Falling back to browser mode.`);
    console.error(
      "NEXT:\n  - Try again later, or fall back to full browser scraping without RSS.\n"
    );
    return false;
  }
}

(async () => {
  // Fast path: GitHub README (default)
  if (await tryGithubReadmeFastPath(url)) {
    process.exit(0);
  }

  // Fast path: Reddit RSS (default on)
  if (await tryRedditRssFastPath(url, TurndownService, maxComments)) {
    process.exit(0);
  }

  // Browser-based scraping
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });

  const page = await context.newPage();
  const consoleLogs = [];

  page.on("console", (msg) => {
    try {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
      if (consoleLogs.length > 200) consoleLogs.shift();
    } catch (e) {}
  });

  page.on("pageerror", (err) => {
    consoleLogs.push(
      `[pageerror] ${String(err && err.message ? err.message : err)}`
    );
    if (consoleLogs.length > 200) consoleLogs.shift();
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(300);

    await waitForStableText(page, {
      minLen: 800,
      stableRounds: 3,
      intervalMs: 700,
      timeoutMs: 30000,
    });

    await smartAutoScroll(page, {
      maxSteps: 40,
      stepPx: 700,
      delayMs: 80,
      maxMs: 12000,
    });

    await waitForStableText(page, {
      minLen: 800,
      stableRounds: 2,
      intervalMs: 600,
      timeoutMs: 15000,
    });

    const html = await page.content();
    const title = await page.title();
    const finalUrl = page.url();

    const dom = new JSDOM(html, { url: finalUrl });
    sanitizeDom(dom.window.document, finalUrl);

    const reader = new Readability(dom.window.document, { keepClasses: false });
    const article = reader.parse();

    let extractedTitle = title || "Untitled";
    let extractedContent = "";
    let extractionMode = "unknown";
    let fallbackSelector = "N/A";

    const turndownService = buildTurndown();

    if (
      article &&
      article.content &&
      article.textContent &&
      article.textContent.trim().length > 200
    ) {
      const at = (article.title || "").trim();
      if (
        at &&
        !at.includes("微信公众平台") &&
        !at.includes("Sina Visitor System")
      ) {
        extractedTitle = at;
      }

      extractedContent = turndownService.turndown(article.content);
      extractionMode = "readability";
    } else {
      console.error(
        "WARN: Readability failed or content too short. Falling back to best container."
      );

      const fb = pickFallbackContainerHtml(dom.window.document);
      fallbackSelector = fb.selector;
      extractedContent = turndownService.turndown(fb.html);
      extractionMode = "fallback-container";

      if (extractedContent.trim().length < 200) {
        console.error(
          "WARN: Fallback container content too short. Falling back to body innerText."
        );
        extractedContent = await page.evaluate(() =>
          document.body ? document.body.innerText : ""
        );
        extractionMode = "body-innerText";
      }
    }

    if (extractedContent.trim().length < 200) {
      const info = {
        inputUrl: url,
        finalUrl: page.url(),
        pageTitle: await page.title(),
        contentLength: extractedContent.length,
        extractionMode,
        fallbackSelector,
        ts: nowIso(),
      };

      console.error(
        "WARN: Unreliable result after extraction. Debug Info:",
        JSON.stringify(info)
      );

      try {
        const screenshotPath = `/tmp/scrape-fail-${info.ts}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.error(`DEBUG: Saved screenshot: ${screenshotPath}`);
      } catch (e) {
        console.error(`DEBUG: Could not save screenshot: ${e.message}`);
      }

      if (consoleLogs.length > 0) {
        console.error("DEBUG: Recent page console logs:");
        console.error(consoleLogs.slice(-30).join("\n"));
      }

      console.error("ERROR: Scraping failed to get meaningful content.");
      console.error(
        "NEXT:\n  - Try a different tool or a simpler HTTP-based fetch (curl/wget)." +
          "\n  - For highly dynamic or protected pages, consider manual review in a full browser.\n"
      );
      process.exit(1);
    }

    console.log("--- METADATA ---");
    console.log(`Title: ${extractedTitle}`);
    console.log(`Author: ${article ? article.byline || "N/A" : "N/A"}`);
    console.log(`Site: ${article ? article.siteName || "N/A" : "N/A"}`);
    console.log(`FinalURL: ${page.url()}`);
    console.log(`Extraction: ${extractionMode}`);
    if (extractionMode !== "readability") {
      console.log(`FallbackSelector: ${fallbackSelector}`);
    }
    console.log("--- MARKDOWN ---");
    console.log(extractedContent);
  } catch (error) {
    console.error(`ERROR: Scrape operation failed: ${error.message}`);
    try {
      const finalUrl = page.url();
      const pageTitle = await page.title();
      console.error(
        `DEBUG: Current URL: ${finalUrl}, Page Title: ${pageTitle}`
      );
    } catch (e) {
      console.error(
        `DEBUG: Could not get current URL or page title after error: ${e.message}`
      );
    }
    console.error(
      "NEXT:\n  - Check network connectivity or site availability.\n" +
        "  - If the problem persists, open the URL in a full browser for manual inspection.\n"
    );
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
