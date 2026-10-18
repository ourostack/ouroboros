import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { loadConfiguredShepherdEvaluationJudge, openShepherdJudgeEvaluationOutput,
  runShepherdJudgeEvaluationCommand } from "../../../senses/shepherd/judge-evaluation-command"
import { isShepherdJudgeAnswerValid, type ReturnPacket } from "../../../senses/shepherd/judge"
import { runShepherdJudgeEvaluation } from "../../../senses/shepherd/judge-evaluation"
import corpus from "../../../senses/shepherd/shepherd-judge-corpus-v1.json"

const mocks = vi.hoisted(() => ({ getAgentRoot: vi.fn(), getProviderRuntime: vi.fn() }))
vi.mock("../../../heart/identity", () => ({ getAgentRoot: mocks.getAgentRoot }))
vi.mock("../../../heart/core", () => ({ getProviderRuntime: mocks.getProviderRuntime }))
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), writeSync: vi.fn(actual.writeSync) }
})
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs")
const packet: ReturnPacket = { human: "Synthetic", agent: "Copilot", cwd: "/synthetic", task: null,
  lastBody: null, backgroundWork: false, screen: "Synthetic finished local-only task." }
function bundle(asDirectory = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-eval-runtime-"))
  if (asDirectory) fs.mkdirSync(path.join(root, "agent.json"))
  else fs.writeFileSync(path.join(root, "agent.json"), "{}")
  mocks.getAgentRoot.mockReturnValue(root)
  return root
}
afterEach(() => {
  vi.restoreAllMocks()
  mocks.getAgentRoot.mockReset()
  mocks.getProviderRuntime.mockReset()
  vi.mocked(fs.readFileSync).mockImplementation(actualFs.readFileSync)
  vi.mocked(fs.writeSync).mockImplementation(actualFs.writeSync)
})
describe("classification runtime binding", () => {
  it.each(["not JSON", "null", "[]", "1", "{}", '{"kind":null,"reason":"invalid"}',
    '{"kind":"invalid","reason":"unknown kind"}', '{"kind":"unclear"}', '{"kind":"unclear","reason":null}',
    '{"kind":"unclear","reason":"   "}', 'Quoted {"kind":"unclear","reason":"not the model answer"}'])(
    "refuses malformed or nonconforming evaluation answers: %s", answer => {
      expect(isShepherdJudgeAnswerValid(answer)).toBe(false)
    })
  it("accepts a genuine explicit unclear verdict and existing fenced JSON normalization", () => {
    expect(isShepherdJudgeAnswerValid('{"kind":"unclear","reply":null,"reason":"Unsupported UI."}')).toBe(true)
    expect(isShepherdJudgeAnswerValid('```json\n{"kind":"unclear","reply":null,"reason":"Unsupported UI."}\n```')).toBe(true)
  })

  it("uses the actual selected inner provider API, no tools, low reasoning and a hard deadline", async () => {
    const root = bundle()
    const streamTurn = vi.fn(async () => ({ content: '{"kind":"done","reply":null,"reason":"Synthetic finished task."}', usage: { input_tokens: 7 } }))
    const resetTurnState = vi.fn()
    mocks.getProviderRuntime.mockResolvedValue({ id: "synthetic-provider", model: "synthetic-model", streamTurn, resetTurnState })
    const loaded = await loadConfiguredShepherdEvaluationJudge("synthetic")
    expect(mocks.getProviderRuntime).toHaveBeenCalledWith("agent", { agentName: "synthetic", agentRoot: root })
    expect(loaded.provenance).toMatchObject({ provider: "synthetic-provider", model: "synthetic-model" })
    expect(loaded.provenance.judgeSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(loaded.provenance.evaluatorSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(await loaded.judge(packet)).toMatchObject({ kind: "done", inputTokens: 7 })
    expect(resetTurnState).toHaveBeenCalledOnce()
    expect(streamTurn).toHaveBeenCalledWith(expect.objectContaining({ activeTools: [], toolChoiceRequired: false,
      reasoningEffort: "low", signal: expect.any(AbortSignal) }))
  })

  it("refuses absent or non-file bundles without creating an agent or contacting a provider", async () => {
    bundle(true)
    await expect(loadConfiguredShepherdEvaluationJudge("synthetic")).rejects.toThrow(/existing agent.json/)
    mocks.getAgentRoot.mockReturnValue(path.join(os.tmpdir(), "synthetic-evaluation-missing-parent", "missing.ouro"))
    await expect(loadConfiguredShepherdEvaluationJudge("synthetic")).rejects.toThrow()
    expect(mocks.getProviderRuntime).not.toHaveBeenCalled()
  })

  it("never awards expected-unclear credit to malformed answers hidden by the production safe fallback", async () => {
    bundle()
    let call = 0
    mocks.getProviderRuntime.mockResolvedValue({ id: "synthetic-provider", model: "synthetic-model", streamTurn: async () => {
      const item = corpus.cases[call++ % corpus.cases.length]!
      return { content: item.expectedKind === "unclear" ? "not a JSON judgment"
        : JSON.stringify({ kind: item.expectedKind, reply: item.expectedKind === "premature" ? { text: "Continue the authorized task." } : null,
          reason: "Synthetic parser-credit reproduction." }) }
    } })
    const loaded = await loadConfiguredShepherdEvaluationJudge("synthetic")
    const report = await runShepherdJudgeEvaluation(corpus, loaded.judge, loaded.provenance)
    expect(report.classificationPassed).toBe(false)
    expect(report.errors).toBe(48)
    expect(report.results.filter(row => row.expectedKind === "unclear").every(row => !row.correct)).toBe(true)
  })

  it("refuses missing provider content instead of silently accepting an empty safe fallback", async () => {
    bundle()
    mocks.getProviderRuntime.mockResolvedValue({ id: "fixture", model: "fixture", streamTurn: async () => ({}) })
    const loaded = await loadConfiguredShepherdEvaluationJudge("synthetic")
    await expect(loaded.judge(packet)).rejects.toThrow(/no classification credit/)
  })

  it.each([null, {}, { version: 4 }])("refuses unidentified package provenance: %j", async metadata => {
    bundle()
    mocks.getProviderRuntime.mockResolvedValue({ id: "fixture", model: "fixture" })
    vi.mocked(fs.readFileSync).mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === path.resolve(__dirname, "../../../../package.json")) return JSON.stringify(metadata)
      return actualFs.readFileSync(...args)
    })
    await expect(loadConfiguredShepherdEvaluationJudge("synthetic")).rejects.toThrow(/runtime package version/)
  })

  it("rewrites the same reserved private output from offset zero, including shorter error reports", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-eval-output-")), "report.json")
    const output = openShepherdJudgeEvaluationOutput(file)
    output.write({ state: "running", results: Array(10).fill("synthetic") })
    output.write({ state: "error" })
    output.close()
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ state: "error" })
  })

  it("explicitly refuses a zero-progress filesystem write", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-eval-write-")), "report.json")
    const output = openShepherdJudgeEvaluationOutput(file)
    vi.mocked(fs.writeSync).mockReturnValueOnce(0)
    expect(() => output.write({ state: "running" })).toThrow(/no progress/)
    output.close()
  })

  it("prints actionable nonzero default command failures without resolving credentials", async () => {
    const print = vi.spyOn(console, "log").mockImplementation(() => {})
    expect(await runShepherdJudgeEvaluationCommand([])).toBe(1)
    expect(print).toHaveBeenCalledWith(expect.stringContaining("error"))
    expect(mocks.getProviderRuntime).not.toHaveBeenCalled()
  })
})
