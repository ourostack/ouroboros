import { runSessionPlaybackCli } from "./session-playback-cli"

const code = runSessionPlaybackCli(process.argv.slice(2))
// A failure ends stderr with its code, as every ouro command's does.
const failure = ({ 2: "usage" } as Record<number, string>)[code]
if (failure) process.stderr.write(`code: ${failure}\n`)
process.exit(code)
