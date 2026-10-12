/** Flags whose next argument is a value the caller may consider secret. */
const VALUE_FLAGS = new Set(["--value", "--secret", "--password", "--token"])

/**
 * A command line that is safe to log: the argument after a value flag, and the value in
 * `--flag=value`, is replaced. `ouro vault config set --value <secret>` is a supported way to
 * store a credential, and the daemon log is not a place for it.
 */
export function redactCliArgs(args: readonly string[]): string[] {
  return args.map((arg, index) => {
    if (index > 0 && VALUE_FLAGS.has(args[index - 1]!)) return "[redacted]"
    const [flag] = arg.split("=", 1)
    return arg.includes("=") && VALUE_FLAGS.has(flag!) ? `${flag}=[redacted]` : arg
  })
}
