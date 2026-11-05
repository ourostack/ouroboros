import { runShepherdJudgeEvaluationCommand } from "./judge-evaluation-command"
import { emitNervesEvent } from "../../nerves/runtime"
import { redactSecrets } from "./redact"

void runShepherdJudgeEvaluationCommand(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(error => {
  const detail = redactSecrets(String(error)).slice(0, 2000)
  emitNervesEvent({ component: "senses", level: "error", event: "senses.shepherd_judge_evaluation_entry_error",
    message: "classification command rejected unexpectedly", meta: { phase: "judge-classification-only", error: detail } })
  // eslint-disable-next-line no-console -- terminal UX: last-resort nonzero evaluation failure
  console.error(JSON.stringify({ error: detail, v1Qualified: false }))
  process.exitCode = 1
})
