// The grade, once a U conversation has ended: node grade.mjs <project>. Always prints every section:
// {"typecheck":{ok,output},"axe":{ok,violations,output},"hidden":{firstPressHeld,confirmedOnce187,statusSaysDone,detail},
//  "escape":{hits},"recheck"?:{...hidden}}
// When the static scan finds a way out of the page named in the model's files, the hidden test runs again in a fresh
// process (recheck; every page run refuses code from strings in the runner's realm and freezes the page's built-ins
// before the component loads), and product U's grader counts the run only when both pass.
import { escapeScan, hidden, projectArg, scan, typecheck } from "./lib.mjs"

const project = projectArg()
const escape = escapeScan(project)
const result = { typecheck: typecheck(project), axe: await scan(project), hidden: await hidden(project), escape }
if (escape.hits.length > 0) result.recheck = await hidden(project)
process.stdout.write(JSON.stringify(result))
