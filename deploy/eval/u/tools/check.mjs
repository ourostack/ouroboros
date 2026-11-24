// run_checks: node check.mjs <project>. Prints {"typecheck":{ok,output},"axe":{ok,violations,output}}.
import { projectArg, scan, typecheck } from "./lib.mjs"

const project = projectArg()
const result = { typecheck: typecheck(project), axe: await scan(project) }
process.stdout.write(JSON.stringify(result))
