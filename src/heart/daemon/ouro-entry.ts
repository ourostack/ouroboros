#!/usr/bin/env node
// First, so every later module can come from the compile cache.
import "./compile-cache"
import { defaultPostToolUseDeps, isPostToolUseHook, runPostToolUseHook } from "./hook-post-tool-use"

// Claude Code runs `ouro hook post-tool-use` after every tool call in every session, so it skips loading the CLI
// (hook-post-tool-use.ts). Every other command loads it.
const argv = process.argv.slice(2)
if (isPostToolUseHook(argv)) void runPostToolUseHook(argv[3], defaultPostToolUseDeps())
else void import("./ouro-cli-main")
