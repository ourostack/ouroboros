import { runAuditCli } from "./cli"

const code = runAuditCli(process.argv.slice(2))
// A failure ends stderr with its code, as every ouro command's does.
const failure = ({ 1: "audit-failed", 2: "no-run-dir" } as Record<number, string>)[code]
if (failure) process.stderr.write(`code: ${failure}\n`)
// exitCode, not process.exit: exit can drop the stderr line on a macOS pipe.
process.exitCode = code
