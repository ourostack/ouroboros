// A claimed entry point: it reaches the parser through run.ts. It checks two words first: "up" is a word the parser
// handles too, and "rescue" is one only this entry knows, so it is a door of its own.
import { parse } from "./run"

if (process.argv[2] === "up") console.log("starting")
if (process.argv[2] === "rescue") process.exit(0)
parse(process.argv.slice(2))
