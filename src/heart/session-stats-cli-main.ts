import { runSessionStatsCli } from "./session-stats"

const code = runSessionStatsCli(process.argv.slice(2))
process.exit(code)
