#!/usr/bin/env node
// First, so every later module can come from the compile cache.
import { ouroCompileCacheDirectory } from "./compile-cache"
import { redactCliArgs } from "./cli-arg-redaction"
import { emitNervesEvent } from "../../nerves/runtime"
import { configureDaemonRuntimeLogger } from "./runtime-logging"
import { runOuroBotWrapper } from "../versioning/ouro-bot-wrapper"

configureDaemonRuntimeLogger("ouro-bot")

emitNervesEvent({
  component: "daemon",
  event: "daemon.ouro_bot_entry_start",
  message: "starting ouro.bot wrapper entrypoint",
  meta: { args: redactCliArgs(process.argv.slice(2)), compileCache: ouroCompileCacheDirectory },
})

void runOuroBotWrapper(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.ouro_bot_entry_error",
    message: "ouro.bot wrapper entrypoint failed",
    meta: { error: message },
  })
  process.exit(1)
})
