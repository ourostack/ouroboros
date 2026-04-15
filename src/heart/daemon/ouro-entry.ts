#!/usr/bin/env node
import { emitNervesEvent } from "../../nerves/runtime"
import { runOuroCli } from "./daemon-cli"
import { configureDaemonRuntimeLogger } from "./runtime-logging"

configureDaemonRuntimeLogger("ouro")

emitNervesEvent({
  component: "daemon",
  event: "daemon.cli_entry_start",
  message: "starting ouro CLI entrypoint",
  meta: { args: process.argv.slice(2) },
})

void runOuroCli(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.cli_entry_error",
    message: "ouro CLI entrypoint failed",
    meta: { error: message },
  })
  process.exit(1)
})
