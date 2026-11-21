#!/usr/bin/env node
// First, so every later module can come from the compile cache.
import { ouroCompileCacheDirectory } from "./compile-cache"
import { emitNervesEvent } from "../../nerves/runtime"
import { redactCliArgs } from "./cli-arg-redaction"
import { runOuroCli } from "./daemon-cli"
import { gateCommandArgs } from "./cli-gate"
import { configureDaemonRuntimeLogger } from "./runtime-logging"
import { activatePortableGit } from "./portable-git"

if (process.argv[2] === "shepherd" && process.argv[3] !== "chat") configureDaemonRuntimeLogger("ouro", { machine: true })
else configureDaemonRuntimeLogger("ouro")
activatePortableGit()

emitNervesEvent({
  component: "daemon",
  event: "daemon.cli_entry_start",
  message: "starting ouro CLI entrypoint",
  meta: { args: redactCliArgs(process.argv.slice(2)), compileCache: ouroCompileCacheDirectory },
})

const gate = gateCommandArgs(process.argv.slice(2))
// A failure ends with the code its Ouro AX card names (see `ouro help --json`), so an agent can look up the fix.
const withCode = (message: string, code: unknown): string => (typeof code === "string" ? `${message}\ncode: ${code}\n` : `${message}\n`)

if (gate.kind === "refuse") {
  process.stderr.write(withCode(gate.message, gate.code))
  process.exitCode = 1
} else if (gate.kind === "preview" || gate.kind === "help") {
  process.stdout.write(`${gate.text}\n`)
} else {
  void runOuroCli(gate.args).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined
    process.stderr.write(withCode(message, code))
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.cli_entry_error",
      message: "ouro CLI entrypoint failed",
      meta: typeof code === "string" ? { error: message, code } : { error: message },
    })
    process.exit(1)
  })
}
