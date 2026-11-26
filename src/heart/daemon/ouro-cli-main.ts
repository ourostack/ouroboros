// The ouro CLI, which ouro-entry.ts loads and runs for every command but the per-tool hook.
import { ouroCompileCacheDirectory } from "./compile-cache"
import { emitNervesEvent } from "../../nerves/runtime"
import { redactCliArgs } from "./cli-arg-redaction"
import { runOuroCli } from "./daemon-cli"
import { errorText, gateCommandArgs } from "./cli-gate"
import { quietPipes } from "../../ouro-ax/cli"
import { configureDaemonRuntimeLogger } from "./runtime-logging"
import { activatePortableGit } from "./portable-git"

/** Runs the CLI on the arguments after `ouro`. */
export function runOuroEntry(args: string[]): void {
  if (args[0] === "shepherd" && args[1] !== "chat") configureDaemonRuntimeLogger("ouro", { machine: true })
  else configureDaemonRuntimeLogger("ouro")
  activatePortableGit()

  emitNervesEvent({
    component: "daemon",
    event: "daemon.cli_entry_start",
    message: "starting ouro CLI entrypoint",
    meta: { args: redactCliArgs(args), compileCache: ouroCompileCacheDirectory },
  })

  // A reader that closes the pipe early (`ouro --help | head -1`) ends the command quietly, not with a stack trace.
  quietPipes(process)
  const gate = gateCommandArgs(args)
  // A failure is one stderr line ending with the code its Ouro AX card names (see `ouro help --json`).
  const withCode = (message: string, code: unknown): string => `${errorText(args, message, typeof code === "string" ? code : undefined)}\n`

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
}
