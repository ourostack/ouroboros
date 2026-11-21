// A claimed entry point: it reaches the parser through run.ts.
import { parse } from "./run"

parse(process.argv.slice(2))
