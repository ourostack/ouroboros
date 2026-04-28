import { runNervesReviewCli } from "./cli"

const code = runNervesReviewCli(process.argv.slice(2))
process.exit(code)
