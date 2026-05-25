#!/usr/bin/env node
// Bootstrap installer for @ouro.bot/cli.
// Installs into ~/.ouro-cli/ versioned layout, creates wrapper, adds to PATH.
// After first run, the wrapper at ~/.ouro-cli/bin/ouro handles everything.
"use strict";

const { execSync, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const OURO_HOME = path.join(os.homedir(), ".ouro-cli");
const VERSIONS_DIR = path.join(OURO_HOME, "versions");
const BIN_DIR = path.join(OURO_HOME, "bin");
const CURRENT_LINK = path.join(OURO_HOME, "CurrentVersion");
const WRAPPER_PATH = path.join(BIN_DIR, "ouro");
const ENTRY_RELPATH = "node_modules/@ouro.bot/cli/dist/heart/daemon/ouro-entry.js";

const WRAPPER_SCRIPT = `#!/bin/sh
ENTRY="$HOME/.ouro-cli/CurrentVersion/${ENTRY_RELPATH}"
if [ ! -e "$ENTRY" ]; then
  echo "ouro not installed. Run: npx ouro.bot@latest" >&2
  exit 1
fi
exec node "$ENTRY" "$@"
`;

function resolveBundledVersion() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
    if (typeof packageJson.version === "string" && packageJson.version.trim()) {
      return packageJson.version.trim();
    }
  } catch {
    // Fall through to the explicit error below.
  }

  console.error("failed to resolve bundled ouro.bot package version.");
  process.exit(1);
}

function getCurrentVersion() {
  try {
    const target = fs.readlinkSync(CURRENT_LINK);
    return path.basename(target);
  } catch {
    return null;
  }
}

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifier(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareVersions(a, b) {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);
  if (!parsedA || !parsedB) return 0;
  for (const key of ["major", "minor", "patch"]) {
    const diff = parsedA[key] - parsedB[key];
    if (diff !== 0) return diff;
  }
  if (parsedA.prerelease.length === 0 && parsedB.prerelease.length === 0) return 0;
  if (parsedA.prerelease.length === 0) return 1;
  if (parsedB.prerelease.length === 0) return -1;
  const length = Math.max(parsedA.prerelease.length, parsedB.prerelease.length);
  for (let i = 0; i < length; i++) {
    const left = parsedA.prerelease[i];
    const right = parsedB.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const diff = compareIdentifier(left, right);
    if (diff !== 0) return diff;
  }
  return 0;
}

function installedEntryPath(version) {
  return path.join(VERSIONS_DIR, version, ENTRY_RELPATH);
}

function ensureLayout() {
  fs.mkdirSync(OURO_HOME, { recursive: true });
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(VERSIONS_DIR, { recursive: true });
}

function installVersion(version) {
  const versionDir = path.join(VERSIONS_DIR, version);
  if (fs.existsSync(installedEntryPath(version))) {
    return; // Already installed
  }
  console.error(`installing @ouro.bot/cli@${version}...`);
  fs.mkdirSync(versionDir, { recursive: true });
  execSync(`npm install --prefix "${versionDir}" @ouro.bot/cli@${version}`, { stdio: "pipe" });
}

function activateVersion(version) {
  const previousVersion = getCurrentVersion();
  const newTarget = path.join(VERSIONS_DIR, version);
  const previousLink = path.join(OURO_HOME, "previous");

  // Update previous symlink
  if (previousVersion) {
    try { fs.unlinkSync(previousLink); } catch { /* may not exist */ }
    fs.symlinkSync(path.join(VERSIONS_DIR, previousVersion), previousLink);
  }

  // Update CurrentVersion symlink
  try { fs.unlinkSync(CURRENT_LINK); } catch { /* may not exist */ }
  fs.symlinkSync(newTarget, CURRENT_LINK);
}

function installWrapper() {
  const existing = fs.existsSync(WRAPPER_PATH) ? fs.readFileSync(WRAPPER_PATH, "utf-8") : "";
  if (existing === WRAPPER_SCRIPT) return;
  fs.writeFileSync(WRAPPER_PATH, WRAPPER_SCRIPT, { mode: 0o755 });
}

function addToPath() {
  const shell = process.env.SHELL;
  if (!shell) return;
  const base = path.basename(shell);
  let profilePath;
  if (base === "zsh") profilePath = path.join(os.homedir(), ".zshrc");
  else if (base === "bash") profilePath = process.platform === "darwin"
    ? path.join(os.homedir(), ".bash_profile")
    : path.join(os.homedir(), ".bashrc");
  else if (base === "fish") profilePath = path.join(os.homedir(), ".config", "fish", "config.fish");
  else return;

  try {
    const content = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, "utf-8") : "";
    if (content.includes(BIN_DIR)) return; // Already in PATH
    const line = base === "fish"
      ? `\n# Added by ouro\nset -gx PATH ${BIN_DIR} $PATH\n`
      : `\n# Added by ouro\nexport PATH="${BIN_DIR}:$PATH"\n`;
    fs.appendFileSync(profilePath, line);
  } catch {
    // Best effort
  }
}

function cleanupOldWrapper() {
  const oldWrapper = path.join(os.homedir(), ".local", "bin", "ouro");
  const oldBinDir = path.join(os.homedir(), ".local", "bin");
  try {
    if (fs.existsSync(oldWrapper)) {
      fs.unlinkSync(oldWrapper);
      // Remove directory if empty
      try {
        const entries = fs.readdirSync(oldBinDir);
        if (entries.length === 0) fs.rmdirSync(oldBinDir);
      } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}

// ── Main ──

const previousVersion = getCurrentVersion();
const bundledVersion = resolveBundledVersion();
const useInstalledNewer = previousVersion
  && compareVersions(previousVersion, bundledVersion) > 0
  && fs.existsSync(installedEntryPath(previousVersion));

ensureLayout();
if (!useInstalledNewer) {
  installVersion(bundledVersion);
}

if (!useInstalledNewer && previousVersion !== bundledVersion) {
  activateVersion(bundledVersion);
  if (previousVersion) {
    console.error(`ouro updated to ${bundledVersion} (was ${previousVersion})`);
  } else {
    console.error(`ouro installed ${bundledVersion}`);
  }
}

installWrapper();
addToPath();
cleanupOldWrapper();

// Run the CLI with the original args
const entry = path.join(CURRENT_LINK, ENTRY_RELPATH);
if (!fs.existsSync(entry)) {
  console.error(`installation failed: ${entry} not found`);
  process.exit(1);
}

const cliArgs = process.argv.slice(2);
if (previousVersion === null) {
  // First install — tell user about PATH (shell-aware)
  const userShell = process.env.SHELL ? path.basename(process.env.SHELL) : "";
  const bashProfile = process.platform === "darwin" ? "~/.bash_profile" : "~/.bashrc";
  const sourceHint = userShell === "zsh" ? "source ~/.zshrc"
    : userShell === "bash" ? `source ${bashProfile}`
    : userShell === "fish" ? "source ~/.config/fish/config.fish"
    : "restart your shell";
  console.error(`\nouro is ready! Open a new terminal or run: ${sourceHint}`);
}

// Always pass through to CLI — first install triggers hatch-or-clone choice
try {
  execFileSync("node", [entry, ...cliArgs], { stdio: "inherit" });
} catch (err) {
  process.exitCode = err.status ?? 1;
}
