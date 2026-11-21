import { runSessionStatsCli } from "./session-stats"

const code = runSessionStatsCli(process.argv.slice(2))
// A failure ends stderr with its code, as every ouro command's does.
const failure = ({ 2: "usage" } as Record<number, string>)[code]
if (failure) process.stderr.write(`code: ${failure}\n`)
process.exit(code)
