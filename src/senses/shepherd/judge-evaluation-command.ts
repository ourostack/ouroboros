import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { emitNervesEvent } from "../../nerves/runtime"
import { assertShepherdJudgeCompletion, createShepherdJudge, isShepherdJudgeAnswerValid,
  ShepherdJudgeResponseError, type JudgeRuntime, type ShepherdJudge } from "./judge"
import { runShepherdJudgeEvaluation, validateShepherdJudgeCorpus, type ShepherdJudgeEvaluationProvenance } from "./judge-evaluation"
import { redactSecrets } from "./redact"
import corpus from "./shepherd-judge-corpus-v1.json"
import { getShepherdJudgeRuntime } from "./judge-runtime"

interface EvaluationOutput {
  write(report: unknown): void
  close(): void
}
export interface ShepherdJudgeEvaluationCommandDependencies {
  loadJudge(agent: string): Promise<{ judge: ShepherdJudge; provenance: ShepherdJudgeEvaluationProvenance }>
  openOutput(file: string): EvaluationOutput
  print(message: string): void
}

export function openShepherdJudgeEvaluationOutput(file: string): EvaluationOutput {
  const fd = fs.openSync(file, "wx", 0o600)
  return {
    write: report => {
      const bytes = Buffer.from(JSON.stringify(report, null, 2) + "\n", "utf8")
      let offset = 0
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset)
        if (written === 0) throw new Error("Evaluation output write made no progress")
        offset += written
      }
      fs.ftruncateSync(fd, bytes.length)
      fs.fsyncSync(fd)
    },
    close: () => fs.closeSync(fd),
  }
}

export async function loadConfiguredShepherdEvaluationJudge(agent: string) {
  const { getAgentRoot } = await import("../../heart/identity")
  const root = getAgentRoot(agent)
  if (!fs.statSync(path.join(root, "agent.json")).isFile()) throw new Error("The selected agent needs an existing agent.json")
  const runtime = await getShepherdJudgeRuntime({ agentName: agent, agentRoot: root })
  const metadata: unknown = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8"))
  if (!metadata || typeof metadata !== "object" || !("version" in metadata) || typeof metadata.version !== "string") {
    throw new Error("Could not identify the evaluation runtime package version")
  }
  const digest = (name: string) => createHash("sha256")
    .update(fs.readFileSync(path.join(__dirname, `${name}${path.extname(__filename)}`))).digest("hex")
  const observed: JudgeRuntime = {
    resetTurnState: messages => runtime.resetTurnState?.(messages),
    streamTurn: async request => {
      const response = await runtime.streamTurn(request)
      assertShepherdJudgeCompletion(response)
      if (!isShepherdJudgeAnswerValid(response.content ?? "")) {
        throw new ShepherdJudgeResponseError("invalid_answer", response.usage?.input_tokens ?? null)
      }
      return response
    },
  }
  return {
    judge: createShepherdJudge(async () => observed, 20_000),
    provenance: {
      provider: runtime.id, model: runtime.model, runtimeVersion: metadata.version,
      judgeSha256: digest("judge"), evaluatorSha256: digest("judge-evaluation"),
      admissionSha256: digest("admission"), runtimeResolverSha256: digest("judge-runtime"),
    },
  }
}

function parseArgs(argv: string[]): { agent: string; output: string } {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]!, value = argv[i + 1]
    if (!["--agent", "--output"].includes(name) || values.has(name) || !value?.trim() || value.startsWith("--")) {
      throw new Error("Usage: shepherd:judge-eval -- --agent NAME --output NEW_PRIVATE_REPORT.json")
    }
    values.set(name, value)
  }
  const agent = values.get("--agent"), output = values.get("--output")
  if (!agent || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(agent) || !output) {
    throw new Error("Explicit --agent NAME and --output NEW_PRIVATE_REPORT.json are required")
  }
  return { agent, output }
}

export async function runShepherdJudgeEvaluationCommand(
  argv: string[], dependencies: ShepherdJudgeEvaluationCommandDependencies = {
    loadJudge: loadConfiguredShepherdEvaluationJudge, openOutput: openShepherdJudgeEvaluationOutput,
    // eslint-disable-next-line no-console -- explicit evaluation command terminal output
    print: message => console.log(message),
  },
): Promise<number> {
  let output: EvaluationOutput | null = null
  let exitCode = 1
  let summary: Record<string, unknown> | null = null
  let outputClosed = false
  emitNervesEvent({ component: "senses", event: "senses.shepherd_judge_evaluation_command_start",
    message: "starting explicit tool-free classification command", meta: {} })
  try {
    const args = parseArgs(argv)
    validateShepherdJudgeCorpus(corpus)
    output = dependencies.openOutput(args.output)
    const { judge, provenance } = await dependencies.loadJudge(args.agent)
    const destination = output
    const report = await runShepherdJudgeEvaluation(corpus, judge, provenance, results => {
      if (results.length % 20 !== 0) return
      destination.write({ schemaVersion: 1, phase: "judge-classification-only", state: "running",
        ...provenance, completedCalls: results.length, results, admissionExercised: false, nativeHostQualified: false, v1Qualified: false })
      dependencies.print(JSON.stringify({ phase: "judge-classification-only", completedCalls: results.length, v1Qualified: false }))
    })
    output.write(report)
    summary = {
      phase: report.phase, classificationPassed: report.classificationPassed, v1Qualified: false,
      provider: report.provider, model: report.model,
      uniqueCases: report.uniqueCases, calls: report.results.length,
      unsafeProposedActions: report.unsafeProposedActions, unattendedKeys: report.unattendedKeys, errors: report.errors,
      errorCounts: report.errorCounts,
      report: args.output, boundary: "Classification evidence only; not v1 qualification.",
    }
    exitCode = report.classificationPassed ? 0 : 1
  } catch (error) {
    const detail = redactSecrets(String(error)).slice(0, 2000)
    dependencies.print(JSON.stringify({ error: detail, v1Qualified: false }))
    if (output) {
      try { output.write({ schemaVersion: 1, phase: "judge-classification-only", state: "error", error: detail, v1Qualified: false }) }
      catch (writeError) { dependencies.print(JSON.stringify({ error: `Could not persist evaluation error: ${redactSecrets(String(writeError)).slice(0, 2000)}` })) }
    }
    emitNervesEvent({ component: "senses", level: "error", event: "senses.shepherd_judge_evaluation_command_error",
      message: "classification command failed; no v1 qualification",
      meta: { phase: "judge-classification-only", outputReserved: output !== null, error: detail } })
  } finally {
    try { output?.close(); outputClosed = output !== null }
    catch (error) {
      exitCode = 1
      const detail = redactSecrets(String(error)).slice(0, 2000)
      dependencies.print(JSON.stringify({ error: `Could not close evaluation output: ${detail}`, v1Qualified: false }))
      emitNervesEvent({ component: "senses", level: "error", event: "senses.shepherd_judge_evaluation_output_close_error",
        message: "evaluation output close failed", meta: { phase: "judge-classification-only", error: detail } })
    }
  }
  if (summary && outputClosed) {
    dependencies.print(JSON.stringify(summary))
    emitNervesEvent({ component: "senses", event: "senses.shepherd_judge_evaluation_command_end",
      message: "classification report persisted and closed", meta: { classificationPassed: summary.classificationPassed, v1Qualified: false } })
  }
  return exitCode
}
