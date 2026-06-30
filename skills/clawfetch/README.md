# clawfetch Skill

This directory is a thin OpenClaw/ClawHub skill wrapper for the published `clawfetch` npm CLI. It is not a standalone scraper project and does not copy clawfetch source code.

## Why It Exists

The skill lets Agents call clawfetch as a controlled tool for turning web pages, GitHub README pages, and Reddit threads into knowledge-base friendly markdown. The CLI remains the only implementation of scraping, runtime lifecycle, site-specific behavior, and error recovery.

## Install Model

Installation is explicit and two-step:

1. Install or copy this skill wrapper directory.
2. Run bootstrap from this directory:

```bash
cd skills/clawfetch
./bootstrap_deps.sh
```

The bootstrap script installs the published `clawfetch` npm package into this skill directory as `node_modules/clawfetch`. It does not run `git clone`, download a source tree, modify global npm state, change system paths, or install unrelated tools.

By default the script follows the version in the project root `package.json`. If the wrapper is distributed without the project root, it falls back to the pinned version recorded in the script. That fallback exists only because standalone ClawHub distribution cannot dynamically read the project root; keep it aligned with the current published CLI version.

## Usage

After bootstrap, call the local CLI:

```bash
node node_modules/clawfetch/clawfetch.js https://example.com/article
node node_modules/clawfetch/clawfetch.js https://github.com/owner/repo
node node_modules/clawfetch/clawfetch.js https://www.reddit.com/r/example/comments/...
```

Runtime lifecycle commands also go through the CLI:

```bash
node node_modules/clawfetch/clawfetch.js runtime install
node node_modules/clawfetch/clawfetch.js runtime check
node node_modules/clawfetch/clawfetch.js runtime repair
node node_modules/clawfetch/clawfetch.js runtime upgrade
node node_modules/clawfetch/clawfetch.js runtime diagnose --json
```

The skill layer must not manage browser runtime directly. It should surface the CLI's `NEXT:` hints to the Agent or operator.

The browser runtime install location and lifecycle are decided by the CLI/project itself. This wrapper does not participate in path selection, runtime repair logic, or version matching.

## Boundaries

This skill does not implement scraping logic, browser launch logic, Playwright package resolution, browser runtime management, GitHub fast-paths, Reddit RSS handling, FlareSolverr support, or markdown conversion.

This skill also does not hide downloads, clone repositories, perform unrelated filesystem operations, or act as a general shell tool.

ClawHub publishes skill content under its registry license policy. The `clawfetch` npm CLI package remains licensed separately under Apache-2.0.
