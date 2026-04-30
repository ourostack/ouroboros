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
  echo "ouro not installed. Run: npx ouro.bot@alpha" >&2
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

function ensureLayout() {
  fs.mkdirSync(OURO_HOME, { recursive: true });
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(VERSIONS_DIR, { recursive: true });
}

function installVersion(version) {
  const versionDir = path.join(VERSIONS_DIR, version);
  if (fs.existsSync(path.join(versionDir, ENTRY_RELPATH))) {
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

ensureLayout();
installVersion(bundledVersion);

if (previousVersion !== bundledVersion) {
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
