// An entry point: reads process.argv at top level and hands it to a runner in another file.
import { runStats } from "./stats"

const code = runStats(process.argv.slice(2))
process.exit(code)
