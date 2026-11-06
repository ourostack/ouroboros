import { runSessionPlaybackCli } from "./session-playback-cli"

const code = runSessionPlaybackCli(process.argv.slice(2))
process.exit(code)
