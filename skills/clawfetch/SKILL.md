---
name: clawfetch
description: Thin OpenClaw and ClawHub wrapper for the published clawfetch npm CLI, used to fetch web pages, GitHub READMEs, and Reddit threads as markdown.
version: 1.0.9
metadata:
  openclaw:
    requires:
      bins:
        - node
        - npm
    homepage: https://github.com/ernestyu/clawfetch
---

# clawfetch

This skill is a thin Agent wrapper around the published `clawfetch` npm CLI. It is not a second scraper product and it does not contain a separate implementation of clawfetch.

Use this skill when an Agent needs to fetch web content into markdown for knowledge-base ingestion, source review, or compact reading. Typical targets include ordinary web pages, GitHub repository README pages, and Reddit threads.

## Boundary

This skill does not:

- vendor the clawfetch source tree
- clone the clawfetch repository
- reimplement browser startup, Playwright runtime handling, GitHub fast-paths, Reddit RSS handling, FlareSolverr support, or markdown conversion
- define a second set of runtime rules
- act as a general shell wrapper

The runtime behavior belongs to the published clawfetch CLI installed by `bootstrap_deps.sh`.

## Bootstrap

Installing this skill only installs the wrapper files in this directory. The actual npm CLI must be installed explicitly:

```bash
cd skills/clawfetch
./bootstrap_deps.sh
```

The bootstrap script installs the published `clawfetch` npm package into this skill directory, under `node_modules/clawfetch`. It does not clone a repository, install unrelated packages, modify global npm state, or change system paths.

When this skill lives inside the clawfetch project repository, bootstrap reads the project root `package.json` and installs that same version. If the wrapper is distributed without the project root, it uses the pinned fallback version in `bootstrap_deps.sh`; maintainers must keep that fallback aligned with the current published CLI version.

## Invocation

After bootstrap, invoke the CLI through the local package installation:

```bash
node node_modules/clawfetch/clawfetch.js https://example.com/article
```

Runtime lifecycle commands are also provided by the CLI itself:

```bash
node node_modules/clawfetch/clawfetch.js runtime install
node node_modules/clawfetch/clawfetch.js runtime check
node node_modules/clawfetch/clawfetch.js runtime diagnose --json
```

Do not bypass these CLI lifecycle commands from the skill layer. Browser runtime install, check, repair, upgrade, clean, and diagnose behavior must remain owned by the clawfetch CLI.

## Agent Guidance

Use the CLI's `NEXT:` hints when recovering from missing dependencies, missing browser runtime, runtime mismatch, protected pages, or weak extraction results. The skill should surface those hints rather than inventing alternate recovery paths.
