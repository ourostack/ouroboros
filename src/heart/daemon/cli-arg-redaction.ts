import { emitNervesEvent } from "../../nerves/runtime"

/** Flags whose next argument is a value the caller may consider secret. */
const VALUE_FLAGS = new Set(["--value", "--secret", "--password", "--token"])

/**
 * A command line that is safe to log: the argument after a value flag, and the value in
 * `--flag=value`, is replaced. `ouro vault config set --value <secret>` is a supported way to
 * store a credential, and the daemon log is not a place for it.
 */
export function redactCliArgs(args: readonly string[]): string[] {
  let redacted = 0
  const safe = args.map((arg, index) => {
    const [flag] = arg.split("=", 1)
    const afterFlag = index > 0 && VALUE_FLAGS.has(args[index - 1]!)
    const inline = arg.includes("=") && VALUE_FLAGS.has(flag!)
    if (afterFlag || inline) redacted += 1
    return afterFlag ? "[redacted]" : inline ? `${flag}=[redacted]` : arg
  })
  if (redacted > 0) {
    emitNervesEvent({ component: "daemon", event: "daemon.cli_args_redacted", message: "kept command-line values out of the log", meta: { redacted } })
  }
  return safe
}
