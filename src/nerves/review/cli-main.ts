import { runNervesReviewCli } from "./cli"

const code = runNervesReviewCli(process.argv.slice(2))
// A failure ends stderr with its code, as every ouro command's does.
const failure = ({ 2: "bad-duration" } as Record<number, string>)[code]
if (failure) process.stderr.write(`code: ${failure}\n`)
// exitCode, not process.exit: exit can drop the stderr line on a macOS pipe.
process.exitCode = code
