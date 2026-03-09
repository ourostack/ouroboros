#!/usr/bin/env node
// Thin wrapper: always delegates to the latest @ouro.bot/cli@alpha.
// This avoids stale npx caching — every invocation resolves the newest CLI.
const { spawn } = require("child_process");
const child = spawn(
  "npx",
  ["--yes", "@ouro.bot/cli@alpha"].concat(process.argv.slice(2)),
  { stdio: "inherit", shell: true }
);
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
