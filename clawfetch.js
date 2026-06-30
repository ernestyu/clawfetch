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
// Dependencies are resolved against clawfetch's supported runtime boundary:
// - Only playwright-core is supported as the Playwright JS runtime.
// - If required npm packages are missing, print installation hints and exit.
// - If --auto-install is provided, clawfetch will attempt a local `npm install`
//   for the missing packages (in the clawfetch install directory).

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

let JSDOM;

const PACKAGE_JSON = (() => {
  try {
    return require("./package.json");
  } catch {
    return { name: "clawfetch", version: "unknown" };
  }
})();

const COMPONENT_ROOT = __dirname;
const RUNTIME_ROOT = path.join(COMPONENT_ROOT, ".clawfetch-runtime");
const BROWSERS_PATH = path.join(RUNTIME_ROOT, "ms-playwright");
const RUNTIME_MANIFEST_PATH = path.join(RUNTIME_ROOT, "runtime.json");
const PREVIOUS_PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || "";
const IGNORED_CLAWFETCH_RUNTIME_DIR = process.env.CLAWFETCH_RUNTIME_DIR || "";
const SUPPORTED_PLAYWRIGHT_PACKAGE = "playwright-core";
const UNSUPPORTED_PLAYWRIGHT_PACKAGE = "playwright";
const SUPPORTED_PLAYWRIGHT_VERSION_RANGE =
  (PACKAGE_JSON.dependencies && PACKAGE_JSON.dependencies[SUPPORTED_PLAYWRIGHT_PACKAGE]) || "*";
const COMPONENT_NODE_MODULES_DIR = path.join(COMPONENT_ROOT, "node_modules");

// Keep clawfetch's Playwright browser binaries inside a component-owned runtime
// directory under the package root instead of relying on ambient host caches.
process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH;

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || '';

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function isInsidePath(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseSemver(version) {
  const match = String(version || "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] > b[key]) return 1;
    if (a[key] < b[key]) return -1;
  }
  return 0;
}

function versionSatisfiesRange(version, range) {
  if (!range || range === "*" || range === "latest") return true;

  const parsedVersion = parseSemver(version);
  if (!parsedVersion) return false;

  if (range.startsWith("^")) {
    const base = parseSemver(range.slice(1));
    if (!base || compareSemver(parsedVersion, base) < 0) return false;

    const upper =
      base.major > 0
        ? { major: base.major + 1, minor: 0, patch: 0 }
        : base.minor > 0
          ? { major: 0, minor: base.minor + 1, patch: 0 }
          : { major: 0, minor: 0, patch: base.patch + 1 };
    return compareSemver(parsedVersion, upper) < 0;
  }

  if (range.startsWith(">=")) {
    const base = parseSemver(range.slice(2).trim());
    return !!base && compareSemver(parsedVersion, base) >= 0;
  }

  const exact = parseSemver(range);
  return !!exact && compareSemver(parsedVersion, exact) === 0;
}

function resolvePackageInfo(packageName) {
  const pkgPath = require.resolve(`${packageName}/package.json`, { paths: [COMPONENT_ROOT] });
  const pkg = require(pkgPath);
  return {
    packageName,
    packageVersion: pkg.version || "unknown",
    packageRoot: path.dirname(pkgPath),
    packageJsonPath: pkgPath,
  };
}

function optionalPackageInfo(packageName) {
  try {
    return resolvePackageInfo(packageName);
  } catch {
    return null;
  }
}

function createRuntimeError(code, message, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  return err;
}

function assertRuntimeRootWritable(action) {
  try {
    fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
    const probePath = path.join(RUNTIME_ROOT, `.write-test-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probePath, action || "runtime", "utf8");
    fs.rmSync(probePath, { force: true });
  } catch (e) {
    throw createRuntimeError(
      "CLAWFETCH_RUNTIME_ROOT_UNWRITABLE",
      `Component runtime directory is not writable: ${RUNTIME_ROOT}`,
      {
        componentRoot: COMPONENT_ROOT,
        runtimeRoot: RUNTIME_ROOT,
        action,
        cause: e && e.message ? e.message : String(e),
      }
    );
  }
}

function loadPlaywrightRuntime() {
  let info;
  try {
    info = resolvePackageInfo(SUPPORTED_PLAYWRIGHT_PACKAGE);
  } catch (e) {
    const unsupported = optionalPackageInfo(UNSUPPORTED_PLAYWRIGHT_PACKAGE);
    throw createRuntimeError(
      "CLAWFETCH_PLAYWRIGHT_MISSING",
      `Missing supported Playwright JS runtime: ${SUPPORTED_PLAYWRIGHT_PACKAGE}.`,
      {
        supportedPackage: SUPPORTED_PLAYWRIGHT_PACKAGE,
        unsupportedPackageFound: unsupported,
        loadError: e && e.message ? e.message : String(e),
      }
    );
  }

  if (!isInsidePath(COMPONENT_NODE_MODULES_DIR, info.packageRoot)) {
    throw createRuntimeError(
      "CLAWFETCH_PLAYWRIGHT_SOURCE_UNSUPPORTED",
      `Unsupported Playwright package source: ${info.packageRoot}`,
      {
        supportedPackage: SUPPORTED_PLAYWRIGHT_PACKAGE,
        expectedSourceRoot: COMPONENT_NODE_MODULES_DIR,
        packageRoot: info.packageRoot,
      }
    );
  }

  if (!versionSatisfiesRange(info.packageVersion, SUPPORTED_PLAYWRIGHT_VERSION_RANGE)) {
    throw createRuntimeError(
      "CLAWFETCH_PLAYWRIGHT_VERSION_UNSUPPORTED",
      `Unsupported ${SUPPORTED_PLAYWRIGHT_PACKAGE} version ${info.packageVersion}; expected ${SUPPORTED_PLAYWRIGHT_VERSION_RANGE}.`,
      {
        supportedPackage: SUPPORTED_PLAYWRIGHT_PACKAGE,
        supportedVersionRange: SUPPORTED_PLAYWRIGHT_VERSION_RANGE,
        packageVersion: info.packageVersion,
      }
    );
  }

  const mod = require(info.packageRoot);
  return {
    chromium: mod.chromium,
    packageName: info.packageName,
    packageVersion: info.packageVersion,
    packageRoot: info.packageRoot,
    packageJsonPath: info.packageJsonPath,
  };
}

function getBrowserDirFromExecutable(executablePath) {
  if (!executablePath) return "";
  let dir = path.dirname(executablePath);
  const root = path.resolve(BROWSERS_PATH);

  while (dir && path.resolve(dir) !== root && path.dirname(dir) !== dir) {
    const base = path.basename(dir);
    if (/^(chromium|chromium_headless_shell|firefox|webkit)-/i.test(base)) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  return "";
}

function listRuntimeEntries() {
  try {
    return fs.readdirSync(BROWSERS_PATH, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function runtimeManifestMatches(status) {
  const manifest = status.runtime.manifest;
  if (!manifest || !status.playwright || !status.playwright.packageName) return false;

  return (
    manifest.componentName === status.component.name &&
    manifest.componentVersion === status.component.version &&
    manifest.playwrightPackage === status.playwright.packageName &&
    manifest.playwrightVersion === status.playwright.packageVersion &&
    manifest.browserName === status.browser.name &&
    path.resolve(manifest.runtimeRoot || "") === path.resolve(status.runtime.root) &&
    path.resolve(manifest.browsersPath || "") === path.resolve(status.runtime.browsersPath)
  );
}

function finalizeRuntimeChecks(status) {
  status.checks.runtimeRootInComponent = isInsidePath(status.component.installDir, status.runtime.root) ? "ok" : "failed";
  status.checks.playwrightPackageType =
    status.playwright && status.playwright.packageName === SUPPORTED_PLAYWRIGHT_PACKAGE ? "ok" : "failed";
  status.checks.playwrightVersion =
    status.playwright &&
    versionSatisfiesRange(status.playwright.packageVersion, SUPPORTED_PLAYWRIGHT_VERSION_RANGE)
      ? "ok"
      : "failed";
  status.checks.playwrightSource =
    status.playwright && status.playwright.packageRoot &&
    isInsidePath(COMPONENT_NODE_MODULES_DIR, status.playwright.packageRoot)
      ? "ok"
      : "failed";
  status.checks.browserManaged =
    status.browser.executablePath && isInsidePath(BROWSERS_PATH, status.browser.executablePath) ? "ok" : "failed";
  status.checks.browserExecutable = status.browser.executableExists ? "ok" : "failed";
  status.checks.manifestMatches = runtimeManifestMatches(status) ? "ok" : "failed";
  status.checks.runtimeComplete =
    status.checks.playwrightPackageType === "ok" &&
    status.checks.playwrightVersion === "ok" &&
    status.checks.playwrightSource === "ok" &&
    status.checks.runtimeRootInComponent === "ok" &&
    status.checks.browserManaged === "ok" &&
    status.checks.browserExecutable === "ok" &&
    status.checks.manifestMatches === "ok";

  status.errors = [];
  if (status.checks.runtimeRootInComponent !== "ok") {
    status.errors.push(`Expected runtime root under component install directory ${status.component.installDir}.`);
  }
  if (status.checks.playwrightPackageType !== "ok") {
    status.errors.push(`Expected Playwright JS package ${SUPPORTED_PLAYWRIGHT_PACKAGE}.`);
  }
  if (status.checks.playwrightVersion !== "ok") {
    status.errors.push(`Expected ${SUPPORTED_PLAYWRIGHT_PACKAGE} version ${SUPPORTED_PLAYWRIGHT_VERSION_RANGE}.`);
  }
  if (status.checks.playwrightSource !== "ok") {
    status.errors.push(`Expected Playwright package under ${COMPONENT_NODE_MODULES_DIR}.`);
  }
  if (status.checks.browserManaged !== "ok") {
    status.errors.push(`Expected Chromium executable under ${BROWSERS_PATH}.`);
  }
  if (status.checks.browserExecutable !== "ok") {
    status.errors.push("Expected Chromium executable is missing.");
  }
  if (status.checks.manifestMatches !== "ok") {
    status.errors.push("Runtime manifest does not match the current component, Playwright package, and browser runtime.");
  }
}

async function collectRuntimeStatus({ verifyLaunch = false } = {}) {
  const status = {
    component: {
      name: PACKAGE_JSON.name || "clawfetch",
      version: PACKAGE_JSON.version || "unknown",
      installDir: COMPONENT_ROOT,
    },
    supportedRuntime: {
      componentRoot: COMPONENT_ROOT,
      runtimeRoot: RUNTIME_ROOT,
      playwrightPackage: SUPPORTED_PLAYWRIGHT_PACKAGE,
      playwrightVersionRange: SUPPORTED_PLAYWRIGHT_VERSION_RANGE,
      packageSourceRoot: COMPONENT_NODE_MODULES_DIR,
      browserName: "chromium",
    },
    runtime: {
      root: RUNTIME_ROOT,
      browsersPath: BROWSERS_PATH,
      manifestPath: RUNTIME_MANIFEST_PATH,
      manifest: readJsonFile(RUNTIME_MANIFEST_PATH),
      previousPlaywrightBrowsersPath: PREVIOUS_PLAYWRIGHT_BROWSERS_PATH || null,
      ignoredClawfetchRuntimeDir: IGNORED_CLAWFETCH_RUNTIME_DIR || null,
    },
    playwright: null,
    browser: {
      name: "chromium",
      executablePath: null,
      browserDir: null,
      executableExists: false,
      installedEntries: listRuntimeEntries(),
    },
    checks: {
      playwrightPackageType: "failed",
      playwrightVersion: "failed",
      playwrightSource: "failed",
      runtimeRootInComponent: "failed",
      browserManaged: "failed",
      browserExecutable: "failed",
      manifestMatches: "failed",
      runtimeComplete: false,
      launch: verifyLaunch ? "failed" : "not-run",
      launchError: null,
    },
    errors: [],
  };

  let pw;
  try {
    pw = loadPlaywrightRuntime();
    status.playwright = {
      packageName: pw.packageName,
      packageVersion: pw.packageVersion,
      packageRoot: pw.packageRoot,
      packageJsonPath: pw.packageJsonPath,
    };
  } catch (e) {
    status.checks.launchError = e.message;
    status.playwright = {
      packageName: null,
      packageVersion: null,
      packageRoot: null,
      packageJsonPath: null,
      loadError: e.message,
      errorCode: e.code || "CLAWFETCH_PLAYWRIGHT_LOAD_FAILED",
      details: e.details || {},
    };
    finalizeRuntimeChecks(status);
    return status;
  }

  try {
    const executablePath = pw.chromium.executablePath();
    status.browser.executablePath = executablePath;
    status.browser.browserDir = getBrowserDirFromExecutable(executablePath);
    status.browser.executableExists = !!(executablePath && fs.existsSync(executablePath));
    status.browser.installedEntries = listRuntimeEntries();
  } catch (e) {
    status.checks.launchError = e.message;
  }

  finalizeRuntimeChecks(status);

  if (verifyLaunch && status.checks.runtimeComplete && pw.chromium) {
    let browser;
    try {
      browser = await pw.chromium.launch({ headless: true, args: ["--no-sandbox"] });
      status.checks.launch = "ok";
      status.checks.launchError = null;
    } catch (e) {
      status.checks.launch = "failed";
      status.checks.launchError = e && e.message ? e.message : String(e);
    } finally {
      try {
        await browser?.close();
      } catch {}
    }
  } else if (verifyLaunch && !status.checks.runtimeComplete && !status.checks.launchError) {
    status.checks.launchError = "Unsupported or incomplete clawfetch Playwright runtime.";
  }

  return status;
}

function printRuntimeStatusText(status) {
  console.log("clawfetch runtime status\n");
  console.log(`Component: ${status.component.name}@${status.component.version}`);
  console.log(`InstallDir: ${status.component.installDir}`);
  console.log(`RuntimeRoot: ${status.runtime.root}`);
  console.log(`BrowsersPath: ${status.runtime.browsersPath}`);
  if (status.runtime.previousPlaywrightBrowsersPath) {
    console.log(`Host PLAYWRIGHT_BROWSERS_PATH ignored: ${status.runtime.previousPlaywrightBrowsersPath}`);
  }
  if (status.runtime.ignoredClawfetchRuntimeDir) {
    console.log(`Host CLAWFETCH_RUNTIME_DIR ignored: ${status.runtime.ignoredClawfetchRuntimeDir}`);
  }
  console.log(
    `SupportedPlaywright: ${status.supportedRuntime.playwrightPackage}@${status.supportedRuntime.playwrightVersionRange}`
  );
  console.log(`ExpectedPlaywrightSource: ${status.supportedRuntime.packageSourceRoot}`);
  console.log(
    `Playwright: ${status.playwright && status.playwright.packageName ? `${status.playwright.packageName}@${status.playwright.packageVersion}` : "missing"}`
  );
  if (status.playwright && status.playwright.packageRoot) {
    console.log(`PlaywrightRoot: ${status.playwright.packageRoot}`);
  }
  console.log(`Browser: ${status.browser.name}`);
  console.log(`Executable: ${status.browser.executablePath || "unknown"}`);
  console.log(`ExecutableExists: ${status.browser.executableExists ? "yes" : "no"}`);
  console.log(`PlaywrightPackageType: ${status.checks.playwrightPackageType}`);
  console.log(`PlaywrightVersion: ${status.checks.playwrightVersion}`);
  console.log(`PlaywrightSource: ${status.checks.playwrightSource}`);
  console.log(`RuntimeRootInComponent: ${status.checks.runtimeRootInComponent}`);
  console.log(`BrowserManaged: ${status.checks.browserManaged}`);
  console.log(`ManifestMatches: ${status.checks.manifestMatches}`);
  console.log(`RuntimeComplete: ${status.checks.runtimeComplete ? "yes" : "no"}`);
  console.log(`LaunchCheck: ${status.checks.launch}`);
  if (status.checks.launchError) {
    console.log(`LaunchError: ${status.checks.launchError.split("\n")[0]}`);
  }
  if (status.errors.length > 0) {
    console.log("RuntimeErrors:");
    for (const error of status.errors) {
      console.log(`  - ${error}`);
    }
  }
  if (status.browser.installedEntries.length > 0) {
    console.log(`InstalledEntries: ${status.browser.installedEntries.join(", ")}`);
  }
  if (status.runtime.manifest) {
    console.log(`ManifestUpdatedAt: ${status.runtime.manifest.updatedAt || "unknown"}`);
  }
}

function printRuntimeNext(status, commandName) {
  if (!status.playwright || !status.playwright.packageName) {
    console.error(
      "\nNEXT:\n" +
        `  - Install the supported Playwright JS runtime in the clawfetch package directory:\n` +
        `      npm install ${SUPPORTED_PLAYWRIGHT_PACKAGE}@\"${SUPPORTED_PLAYWRIGHT_VERSION_RANGE}\"\n` +
        "  - Then initialize the controlled browser runtime:\n" +
        "      clawfetch runtime install\n"
    );
    return;
  }

  if (status.checks.playwrightSource !== "ok") {
    console.error(
      "\nNEXT:\n" +
        "  - Reinstall clawfetch dependencies so Playwright resolves from the component package directory:\n" +
        "      npm install\n" +
        "  - Remove or ignore ambient Playwright packages outside clawfetch; they are not supported runtime sources.\n"
    );
    return;
  }

  if (status.checks.playwrightVersion !== "ok") {
    console.error(
      "\nNEXT:\n" +
        `  - Install a supported ${SUPPORTED_PLAYWRIGHT_PACKAGE} version:\n` +
        `      npm install ${SUPPORTED_PLAYWRIGHT_PACKAGE}@\"${SUPPORTED_PLAYWRIGHT_VERSION_RANGE}\"\n` +
        "  - Then upgrade the controlled browser runtime:\n" +
        "      clawfetch runtime upgrade\n"
    );
    return;
  }

  if (status.checks.manifestMatches !== "ok" && status.browser.executableExists) {
    console.error(
      "\nNEXT:\n" +
        "  - Upgrade or repair the controlled browser runtime so the manifest matches this component:\n" +
        "      clawfetch runtime upgrade\n" +
        "      clawfetch runtime check\n"
    );
    return;
  }

  if (!status.checks.runtimeComplete) {
    console.error(
      "\nNEXT:\n" +
        "  - Initialize the controlled browser runtime:\n" +
        "      clawfetch runtime install\n"
    );
    return;
  }

  if (commandName === "check" && status.checks.launch !== "ok") {
    console.error(
      "\nNEXT:\n" +
        "  - Repair the controlled browser runtime:\n" +
        "      clawfetch runtime repair\n"
    );
  }
}

function resolvePlaywrightCli(packageName, packageRoot) {
  const candidates = [
    path.join(packageRoot, "cli.js"),
    path.join(packageRoot, "lib", "cli", "cli.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`Could not find ${packageName} CLI under ${packageRoot}`);
}

function writeRuntimeManifest(playwrightInfo, action) {
  writeJsonFile(RUNTIME_MANIFEST_PATH, {
    componentName: PACKAGE_JSON.name || "clawfetch",
    componentVersion: PACKAGE_JSON.version || "unknown",
    playwrightPackage: playwrightInfo.packageName,
    playwrightVersion: playwrightInfo.packageVersion,
    browserName: "chromium",
    runtimeRoot: RUNTIME_ROOT,
    browsersPath: BROWSERS_PATH,
    action,
    updatedAt: new Date().toISOString(),
  });
}

function runPlaywrightInstall(action) {
  const pw = loadPlaywrightRuntime();
  const cliPath = resolvePlaywrightCli(pw.packageName, pw.packageRoot);
  assertRuntimeRootWritable(action);
  fs.mkdirSync(BROWSERS_PATH, { recursive: true });

  const result = spawnSync(process.execPath, [cliPath, "install", "chromium"], {
    cwd: COMPONENT_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: BROWSERS_PATH,
    },
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const err = new Error(`Playwright browser install failed with exit code ${result.status}`);
    err.exitCode = result.status || 1;
    throw err;
  }

  writeRuntimeManifest(pw, action);
}

function ensureInsideRuntimeRoot(targetPath) {
  const resolvedRoot = path.resolve(RUNTIME_ROOT);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Refusing to clean outside runtime root: ${resolvedTarget}`);
  }
}

function removePathRecursive(targetPath) {
  ensureInsideRuntimeRoot(targetPath);
  fs.rmSync(targetPath, { recursive: true, force: true });
}

async function handleRuntimeCommand(args) {
  const command = args[0] || "status";
  const flags = new Set(args.slice(1));
  const json = flags.has("--json");

  if (command === "--help" || command === "help") {
    printRuntimeHelp();
    return 0;
  }

  if (command === "status") {
    const status = await collectRuntimeStatus({ verifyLaunch: flags.has("--verify-launch") });
    if (json) console.log(JSON.stringify(status, null, 2));
    else printRuntimeStatusText(status);
    printRuntimeNext(status, "status");
    return status.checks.runtimeComplete ? 0 : 1;
  }

  if (command === "check" || command === "diagnose") {
    const status = await collectRuntimeStatus({ verifyLaunch: true });
    if (json || command === "diagnose") console.log(JSON.stringify(status, null, 2));
    else printRuntimeStatusText(status);
    printRuntimeNext(status, "check");
    return status.checks.runtimeComplete && status.checks.launch === "ok" ? 0 : 1;
  }

  if (command === "install" || command === "repair" || command === "upgrade") {
    try {
      runPlaywrightInstall(command);
    } catch (e) {
      console.error(`ERROR: Runtime ${command} failed: ${e.message}`);
      if (e && e.code && e.code.startsWith("CLAWFETCH_PLAYWRIGHT_")) {
        console.error(
          "NEXT:\n" +
            "  - Fix the supported Playwright JS runtime inside the clawfetch package directory:\n" +
            "      npm install\n" +
            "  - Then retry the runtime lifecycle command:\n" +
            `      clawfetch runtime ${command}\n`
        );
      } else if (e && e.code === "CLAWFETCH_RUNTIME_ROOT_UNWRITABLE") {
        console.error(
          "NEXT:\n" +
            "  - Fix the clawfetch package install so its component runtime directory is writable:\n" +
            `      ${RUNTIME_ROOT}\n` +
            "  - Or reinstall clawfetch into a writable component location, then retry:\n" +
            `      clawfetch runtime ${command}\n`
        );
      } else {
        console.error(
          "NEXT:\n" +
            "  - Check network access and package dependencies, then retry:\n" +
            `      clawfetch runtime ${command}\n`
        );
      }
      return e.exitCode || 1;
    }

    const status = await collectRuntimeStatus({ verifyLaunch: flags.has("--check") });
    if (json) console.log(JSON.stringify(status, null, 2));
    else printRuntimeStatusText(status);
    return status.checks.runtimeComplete ? 0 : 1;
  }

  if (command === "clean") {
    const all = flags.has("--all");
    const yes = flags.has("--yes");
    const status = await collectRuntimeStatus();
    const currentBrowserDir = status.browser.browserDir ? path.resolve(status.browser.browserDir) : "";
    const entries = status.browser.installedEntries.map((entry) => path.join(BROWSERS_PATH, entry));
    const targets = all
      ? [RUNTIME_ROOT]
      : entries.filter((entryPath) => path.resolve(entryPath) !== currentBrowserDir);

    if (!yes) {
      const payload = {
        dryRun: true,
        requireConfirmation: "--yes",
        mode: all ? "all" : "old-runtime-entries",
        targets,
      };
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }

    for (const target of targets) {
      removePathRecursive(target);
    }
    if (all) {
      removePathRecursive(RUNTIME_MANIFEST_PATH);
    } else if (status.playwright && status.playwright.packageName) {
      writeRuntimeManifest(loadPlaywrightRuntime(), "clean");
    }

    const after = await collectRuntimeStatus();
    if (json) console.log(JSON.stringify(after, null, 2));
    else printRuntimeStatusText(after);
    return 0;
  }

  console.error(`ERROR: Unknown runtime command: ${command}`);
  printRuntimeHelp();
  return 2;
}

function printRuntimeHelp() {
  console.log("clawfetch runtime - manage the controlled Playwright browser runtime\n");
  console.log("Usage:");
  console.log("  clawfetch runtime status [--json] [--verify-launch]");
  console.log("  clawfetch runtime install [--check] [--json]");
  console.log("  clawfetch runtime check [--json]");
  console.log("  clawfetch runtime diagnose [--json]");
  console.log("  clawfetch runtime repair [--check] [--json]");
  console.log("  clawfetch runtime upgrade [--check] [--json]");
  console.log("  clawfetch runtime clean [--yes] [--all] [--json]\n");
  console.log("Runtime:");
  console.log("  Browser runtime is fixed under the clawfetch package root:");
  console.log(`  ${RUNTIME_ROOT}`);
  console.log("  CLAWFETCH_RUNTIME_DIR is ignored to keep the component runtime deterministic.");
}

async function fetchViaFlareSolverr(targetUrl) {
  if (!FLARESOLVERR_URL) return null;
  try {
    const res = await fetch(FLARESOLVERR_URL.replace(/\/$/, '') + '/v1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url: targetUrl, maxTimeout: 60000 }),
      signal: AbortSignal.timeout(65000),
    });
    if (!res.ok) {
      console.error(`WARN: FlareSolverr HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (!data || !data.solution || data.solution.status !== 200 || !data.solution.response) {
      console.error('WARN: FlareSolverr did not return a successful solution.');
      return null;
    }
    return {
      html: data.solution.response,
      finalUrl: data.solution.url || targetUrl,
      contentType: (data.solution.headers && (data.solution.headers['content-type'] || data.solution.headers['Content-Type'])) || '',
    };
  } catch (e) {
    console.error(`WARN: FlareSolverr request failed: ${e.message}`);
    return null;
  }
}

function isGarbageExtraction(text) {
  // Heuristic garbage detector inspired by oksskolten's isGarbageExtraction.
  if (!text) return true;
  const raw = String(text);
  // Strip fenced code blocks ```...``` and inline `...`
  let prose = raw.replace(/```[\s\S]*?```/g, '');
  prose = prose.replace(/`[^`]+`/g, '');
  prose = prose.replace(/\s+/g, ' ').trim();
  if (!prose) return true;

  const sentences = prose.match(/[^.!?。！？]+[.!?。！？]/g) || [];
  const proseSentences = sentences.filter((s) => {
    const words = s.trim().split(/\s+/);
    return words.length >= 3;
  });

  if (proseSentences.length < 3) return true;
  if (prose.length < raw.length * 0.1) return true;
  return false;
}

function looksLikeBotBlock(text) {
  const lower = (text || '').toLowerCase();
  const patterns = [
    'checking your browser before accessing',
    'please verify you are a human',
    'enable javascript and cookies',
    'just a moment',
    'attention required',
    'access denied',
    'cloudflare ray id',
  ];
  return patterns.some(p => lower.includes(p));
}

function isKaggleHost(hostname) {
  const h = (hostname || '').toLowerCase();
  return /(^|\.)kaggle\.com$/.test(h);
}

function isSuspiciousKaggleText(text) {
  const lower = (text || '').toLowerCase();
  const patterns = [
    "we can't find that page",
    "we can\u2019t find that page",
    "you can search kaggle above or visit our homepage",
    "kaggle uses cookies from google",
  ];
  return patterns.some(p => lower.includes(p));
}

async function kaggleSimpleFallbackFetch(chromium, url) {
  // Minimal, "raw" Playwright flow (matches the working kaggle_fetch.js):
  // - args: ['--no-sandbox'] only
  // - no custom UA/locale/timezone overrides
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(5000);
    const title = await page.title();
    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '');
    return { title, finalUrl, bodyText };
  } finally {
    await browser.close();
  }
}

const argv = process.argv.slice(2);
const isRuntimeCommand = argv[0] === "runtime";

if (isRuntimeCommand) {
  handleRuntimeCommand(argv.slice(1))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`ERROR: Runtime command failed: ${error && error.message ? error.message : String(error)}`);
      process.exitCode = 1;
    });
} else {

function printHelp() {
  console.log("clawfetch - web page → markdown scraper\n");
  console.log("Usage:");
  console.log("  clawfetch <url> [--max-comments N] [--no-reddit-rss] [--auto-install]");
  console.log("  clawfetch runtime <status|install|check|repair|upgrade|clean|diagnose>\n");
  console.log("Options:");
  console.log("  --help            Show this help and exit");
  console.log("  --max-comments N  Limit number of Reddit comments (0 = no limit; default 50)");
  console.log("  --no-reddit-rss   Disable Reddit RSS fast-path and use browser scraping");
  console.log("  --via-flaresolverr   Fetch HTML via FLARESOLVERR_URL and skip Playwright");
  console.log("  --auto-install    If dependencies are missing, attempt a local 'npm install'\n");
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
const autoInstallDeps = flags.has("--auto-install");

function printPlaywrightRuntimeError(error) {
  console.error(`ERROR: Unsupported clawfetch Playwright runtime: ${error.message}`);
  console.error(
    "\nNEXT:\n" +
      "  - Inspect the runtime boundary:\n" +
      "      clawfetch runtime diagnose --json\n" +
      "  - Repair or upgrade the component-owned runtime:\n" +
      "      clawfetch runtime repair\n" +
      "      clawfetch runtime check\n"
  );
}

function loadDeps() {
  const missing = [];
  let runtimeError = null;

  let runtime;
  try {
    runtime = loadPlaywrightRuntime();
  } catch (e) {
    if (e && e.code === "CLAWFETCH_PLAYWRIGHT_MISSING") {
      missing.push(SUPPORTED_PLAYWRIGHT_PACKAGE);
    } else {
      runtimeError = e;
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

  try {
    ({ JSDOM } = require("jsdom"));
  } catch {
    missing.push("jsdom");
  }

  if (runtimeError) {
    printPlaywrightRuntimeError(runtimeError);
    process.exit(1);
  }

  if (missing.length > 0) {
    if (autoInstallDeps) {
      console.error("WARN: Missing required npm packages:\n  - " + missing.join("\n  - "));
      console.error("Attempting local installation with npm (in " + COMPONENT_ROOT + ")...\n");
      const res = spawnSync("npm", ["install"], {
        stdio: "inherit",
        cwd: COMPONENT_ROOT,
      });
      if (res.status !== 0) {
        console.error(
          "ERROR: npm install failed.\n" +
            "NEXT:\n" +
            "  - Install dependencies manually:\n" +
            "      npm install\n" +
            "  - Then initialize or repair the controlled browser runtime:\n" +
            "      clawfetch runtime install\n"
        );
        process.exit(1);
      }

      return loadDepsNoAuto();
    }

    console.error("ERROR: Missing required npm packages:\n  - " + missing.join("\n  - "));
    console.error(
      "\nNEXT:\n" +
        "  - Install clawfetch dependencies in the package directory:\n" +
        "      npm install\n" +
        "  - Then initialize the controlled browser runtime:\n" +
        "      clawfetch runtime install\n"
    );
    process.exit(1);
  }

  return { chromium: runtime.chromium, Readability, TurndownService };
}

function loadDepsNoAuto() {
  let runtime;
  try {
    runtime = loadPlaywrightRuntime();
  } catch (e) {
    printPlaywrightRuntimeError(e);
    process.exit(1);
  }
  const { Readability } = require("@mozilla/readability");
  const TurndownService = require("turndown");
  ({ JSDOM } = require("jsdom"));
  return { chromium: runtime.chromium, Readability, TurndownService };
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

function extractAnchoredContentHtml(html, articleUrl) {
  // For URLs with a #fragment, extract only the corresponding section
  // (heading + following siblings until next heading of same or higher level).
  // This mirrors oksskolten's anchored extraction strategy, but implemented
  // independently here.
  if (!html || !articleUrl) return html;
  let url;
  try {
    url = new URL(articleUrl);
  } catch {
    return html;
  }
  const hash = (url.hash || '').replace(/^#/, '');
  if (!hash) return html;

  const dom = new JSDOM(html, { url: articleUrl });
  const doc = dom.window.document;
  const target = doc.getElementById(hash);
  if (!target) return html;

  const isHeading = (el) => /^H[1-6]$/i.test(el.tagName);
  const headingLevel = (el) => {
    if (!el) return 6;
    if (isHeading(el)) return Number(el.tagName[1]);
    if (el.getAttribute && el.getAttribute('role') === 'heading') {
      const ariaLevel = Number(el.getAttribute('aria-level') || '6');
      return Number.isFinite(ariaLevel) && ariaLevel > 0 ? ariaLevel : 6;
    }
    return 6;
  };

  const start = isHeading(target)
    ? target
    : (target.closest && target.closest('h1,h2,h3,h4,h5,h6,[role="heading"]')) || target;
  const targetLevel = headingLevel(start);

  let endBoundary = null;
  let current = start;
  while (current && current.nextElementSibling) {
    current = current.nextElementSibling;
    if (headingLevel(current) <= targetLevel) {
      endBoundary = current;
      break;
    }
  }

  const range = doc.createRange();
  range.setStartBefore(start);
  if (endBoundary) range.setEndBefore(endBoundary);
  else if (doc.body && doc.body.lastElementChild) range.setEndAfter(doc.body.lastElementChild);

  const fragment = doc.createElement('article');
  fragment.append(range.cloneContents());
  const fragmentHtml = fragment.innerHTML.trim();
  if (!fragmentHtml) return html;

  const ogImage = doc.querySelector('meta[property="og:image"]');
  const ogTitle = doc.querySelector('meta[property="og:title"]');
  const titleEl = doc.querySelector('title');

  return '<!DOCTYPE html>\n<html><head>' +
    (titleEl ? '<title>' + titleEl.textContent + '</title>' : '') +
    (ogImage ? ogImage.outerHTML : '') +
    (ogTitle ? ogTitle.outerHTML : '') +
    '</head><body><article>' + fragmentHtml + '</article></body></html>';

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


async function runFlareSolverrMode(url) {
  const flare = await fetchViaFlareSolverr(url);
  if (!flare || !flare.html || !flare.html.trim()) {
    console.error('ERROR: FlareSolverr did not return usable HTML.');
    console.error('NEXT: Check FLARESOLVERR_URL and reachability; then open the URL in a full browser to verify Cloudflare/JS challenges.');
    return 1;
  }
  const finalUrl = flare.finalUrl || url;
  const anchoredHtml = extractAnchoredContentHtml(flare.html, finalUrl);
  const dom = new JSDOM(anchoredHtml, { url: finalUrl });
  sanitizeDom(dom.window.document, finalUrl);
  const reader = new Readability(dom.window.document, { keepClasses: false });
  const article = reader.parse();
  const turndownService = buildTurndown();
  let extractedTitle = (article && article.title) || (dom.window.document.title || 'Untitled');
  let extractedContent = '';
  let extractionMode = 'readability-flaresolverr';
  let fallbackSelector = 'N/A';
  if (article && article.content && article.textContent && article.textContent.trim().length > 200) {
    extractedContent = turndownService.turndown(article.content);
  } else {
    const fb = pickFallbackContainerHtml(dom.window.document);
    fallbackSelector = fb.selector;
    extractedContent = turndownService.turndown(fb.html);
    extractionMode = 'fallback-container-flaresolverr';
    if (extractedContent.trim().length < 200 && dom.window.document.body) {
      extractedContent = dom.window.document.body.innerText || '';
      extractionMode = 'body-innerText-flaresolverr';
    }
  }
  if (extractedContent.trim().length < 200 || isGarbageExtraction(extractedContent)) {
    console.error('ERROR: FlareSolverr-based extraction produced too little content.');
    console.error('NEXT: Inspect the page manually to confirm JS-exposed content, or adjust FlareSolverr configuration / fall back to manual copy.');
    return 1;
  }
  console.log('--- METADATA ---');
  console.log(`Title: ${extractedTitle}`);
  console.log(`Author: ${article ? article.byline || 'N/A' : 'N/A'}`);
  console.log(`Site: ${article ? article.siteName || 'N/A' : 'N/A'}`);
  console.log(`FinalURL: ${finalUrl}`);
  console.log(`Extraction: ${extractionMode}`);
  if (!extractionMode.startsWith('readability')) {
    console.log(`FallbackSelector: ${fallbackSelector}`);
  }
  console.log('--- MARKDOWN ---');
  console.log(extractedContent);
  return 0;
}

function looksLikeRuntimeLaunchError(error) {
  const msg = String(error && error.message ? error.message : error || "").toLowerCase();
  return (
    msg.includes("executable doesn't exist") ||
    msg.includes("browser executable") ||
    msg.includes("browser logs") ||
    msg.includes("browserType.launch".toLowerCase()) ||
    msg.includes("host system is missing dependencies")
  );
}

async function main() {
  if (flags.has("--via-flaresolverr")) {
    return await runFlareSolverrMode(url);
  }

  // Fast path: GitHub README (default)
  if (await tryGithubReadmeFastPath(url)) {
    return 0;
  }

  // Fast path: Reddit RSS (default on)
  if (await tryRedditRssFastPath(url, TurndownService, maxComments)) {
    return 0;
  }

  // Browser-based scraping
  let browser;
  let context;
  let page;

  const urlHost = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  const isKaggle = isKaggleHost(urlHost);
  const consoleLogs = [];

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });

    page = await context.newPage();

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

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    if (isKaggle) {
      // Kaggle-style SPA: heavy JS, async content. Use a simpler but more robust strategy:
      // - wait for network idle
      // - then a fixed additional delay to ensure writeup text is rendered
      await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(5000);
    } else {
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
    }

    const html = await page.content();
    const title = await page.title();
    const finalUrl = page.url();

    const anchoredHtml = extractAnchoredContentHtml(html, finalUrl);
    const dom = new JSDOM(anchoredHtml, { url: finalUrl });
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

      if (extractedContent.trim().length < 200 || isGarbageExtraction(extractedContent)) {
        console.error(
          "WARN: Fallback container content too short. Falling back to body innerText."
        );
        extractedContent = await page.evaluate(() =>
          document.body ? document.body.innerText : ""
        );
        extractionMode = "body-innerText";
      }
    }

    // Kaggle-specific safety check: if we still see Kaggle 404/cookie shell,
    // force a final innerText grab after an extra delay.
    if (isKaggle && isSuspiciousKaggleText(extractedContent)) {
      console.error('INFO: Kaggle content looks like 404/cookie shell, retrying with extended wait + body.innerText.');
      await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(5000);
      extractedContent = await page.evaluate(() =>
        document.body ? document.body.innerText : ''
      );
      extractionMode = 'body-innerText-kaggle-fallback';
      fallbackSelector = 'document.body';
    }

    const looksWeak =
      extractedContent.trim().length < 200 ||
      isGarbageExtraction(extractedContent) ||
      (isKaggle && isSuspiciousKaggleText(extractedContent));

    if (looksWeak) {
      // Kaggle 特例兜底：前面这一轮用的是 clawfetch 的浏览器指纹。
      // 如果内容明显不对（太短 / 垃圾 / 明显 404 壳），再走一次“原始 Playwright”流程：
      if (isKaggle) {
        console.error('INFO: Kaggle extraction looks weak, retrying with raw Playwright fingerprint.');
        try {
          const simple = await kaggleSimpleFallbackFetch(chromium, url);
          if (simple && simple.bodyText && simple.bodyText.trim().length > 500) {
            extractedTitle = simple.title || extractedTitle;
            extractedContent = simple.bodyText;
            extractionMode = 'body-innerText-kaggle-raw-playwright';
            fallbackSelector = 'document.body';
          }
        } catch (e) {
          console.error(`WARN: Kaggle raw-playwright fallback failed: ${e.message}`);
        }
      }

      if (extractedContent.trim().length < 200 || isGarbageExtraction(extractedContent)) {
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
        return 1;
      }
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
    return 0;
  } catch (error) {
    console.error(`ERROR: Scrape operation failed: ${error.message}`);
    if (looksLikeRuntimeLaunchError(error)) {
      const status = await collectRuntimeStatus();
      console.error("INFO: The controlled Playwright runtime is missing, unhealthy, or outside the supported runtime boundary.");
      console.error(`DEBUG: RuntimeRoot: ${status.runtime.root}`);
      console.error(`DEBUG: ExpectedExecutable: ${status.browser.executablePath || "unknown"}`);
      if (status.errors.length > 0) {
        console.error("DEBUG: RuntimeErrors:");
        for (const runtimeError of status.errors) {
          console.error(`  - ${runtimeError}`);
        }
      }
      console.error(
        "NEXT:\n" +
          "  - Diagnose, initialize, or repair the clawfetch runtime:\n" +
          "      clawfetch runtime diagnose --json\n" +
          "      clawfetch runtime install\n" +
          "      clawfetch runtime check\n"
      );
      return 1;
    }
    let pageHtml = '';
    try {
      pageHtml = page ? await page.content() : '';
    } catch (_) {}
    if (pageHtml && looksLikeBotBlock(pageHtml)) {
      console.error('INFO: Detected possible bot-block / Cloudflare challenge page.');
      if (!FLARESOLVERR_URL) {
        console.error('NEXT: Configure FLARESOLVERR_URL to point to a FlareSolverr service, or open the URL in a full browser to pass the challenge manually.');
      } else {
        const flare = await fetchViaFlareSolverr(url);
        if (flare && flare.html && flare.html.trim().length > 0) {
          console.error('INFO: Retrying extraction using FlareSolverr HTML.');
          try {
            const dom = new JSDOM(flare.html, { url: flare.finalUrl || url });
            sanitizeDom(dom.window.document, flare.finalUrl || url);
            const reader = new Readability(dom.window.document, { keepClasses: false });
            const article = reader.parse();
            const turndownService = buildTurndown();
            let extractedTitle = (article && article.title) || 'Untitled';
            let extractedContent = '';
            let extractionMode = 'readability-flaresolverr';
            let fallbackSelector = 'N/A';
            if (article && article.content && article.textContent && article.textContent.trim().length > 200) {
              extractedContent = turndownService.turndown(article.content);
            } else {
              const fb = pickFallbackContainerHtml(dom.window.document);
              fallbackSelector = fb.selector;
              extractedContent = turndownService.turndown(fb.html);
              extractionMode = 'fallback-container-flaresolverr';
              if (extractedContent.trim().length < 200 && dom.window.document.body) {
                extractedContent = dom.window.document.body.innerText || '';
                extractionMode = 'body-innerText-flaresolverr';
              }
            }
            if (extractedContent.trim().length >= 200) {
              console.log('--- METADATA ---');
              console.log(`Title: ${extractedTitle}`);
              console.log(`Author: ${article ? article.byline || 'N/A' : 'N/A'}`);
              console.log(`Site: ${article ? article.siteName || 'N/A' : 'N/A'}`);
              console.log(`FinalURL: ${flare.finalUrl || url}`);
              console.log(`Extraction: ${extractionMode}`);
              if (!extractionMode.startsWith('readability')) {
                console.log(`FallbackSelector: ${fallbackSelector}`);
              }
              console.log('--- MARKDOWN ---');
              console.log(extractedContent);
              return 0;
            }
          } catch (e2) {
            console.error(`WARN: FlareSolverr-based extraction failed: ${e2.message}`);
          }
        }
      }
    }
    try {
      if (page) {
        const finalUrl = page.url();
        const pageTitle = await page.title();
        console.error(
          `DEBUG: Current URL: ${finalUrl}, Page Title: ${pageTitle}`
        );
      } else {
        console.error("DEBUG: No page instance available after error.");
      }
    } catch (e) {
      console.error(
        `DEBUG: Could not get current URL or page title after error: ${e.message}`
      );
    }
    console.error(
      "NEXT:\n  - Check network connectivity or site availability.\n" +
        "  - If the problem persists, open the URL in a full browser for manual inspection.\n"
    );
    return 1;
  } finally {
    try {
      await page?.close();
    } catch {}
    try {
      await context?.close();
    } catch {}
    try {
      await browser?.close();
    } catch {}
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`ERROR: Unhandled failure: ${error && error.message ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
