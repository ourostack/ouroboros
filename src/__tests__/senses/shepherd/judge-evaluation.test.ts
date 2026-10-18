import { describe, expect, it, vi } from "vitest"
import corpus from "../../../senses/shepherd/shepherd-judge-corpus-v1.json"
import { runShepherdJudgeEvaluation, validateShepherdJudgeCorpus, wilsonInterval } from "../../../senses/shepherd/judge-evaluation"
import type { JudgeResult, ReturnPacket, ShepherdJudge } from "../../../senses/shepherd/judge"

const provenance = { provider: "synthetic-test", model: "not-a-real-model", runtimeVersion: "test",
  judgeSha256: "a".repeat(64), evaluatorSha256: "b".repeat(64) }
const result = (kind: JudgeResult["kind"]): JudgeResult => ({
  kind, reply: kind === "premature" ? { text: "Continue the existing authorized task." } : null,
  reason: "Synthetic mechanics test only.", inputTokens: 10, latencyMs: 5,
})
const ideal: ShepherdJudge = async (packet: ReturnPacket) => {
  const item = corpus.cases.find(item => item.screen === packet.screen)!
  return result(item.expectedKind as JudgeResult["kind"])
}

describe("Shepherd classification-only evaluation", () => {
  it("freezes eight strata of at least twenty substantive unique cases", () => {
    const checked = validateShepherdJudgeCorpus(corpus)
    expect(checked.cases.length).toBeGreaterThanOrEqual(160)
    expect(new Set(checked.cases.map(item => item.stratum)).size).toBe(8)
    for (const stratum of new Set(checked.cases.map(item => item.stratum))) {
      expect(checked.cases.filter(item => item.stratum === stratum).length).toBeGreaterThanOrEqual(20)
    }
  })

  it("rejects malformed, undersized, duplicate-ID and cosmetically duplicated corpora before judging", async () => {
    const judge = vi.fn(ideal)
    const invalid: unknown[] = [
      null, {}, { ...corpus, version: 2 }, { ...corpus, cases: corpus.cases.slice(1) },
      { ...corpus, cases: corpus.cases.map((item, index) => index === 1 ? { ...item, id: corpus.cases[0]!.id } : item) },
      { ...corpus, cases: corpus.cases.map((item, index) => index === 1 ? { ...item, screen: corpus.cases[0]!.screen.toUpperCase() + " 1234" } : item) },
      { ...corpus, cases: corpus.cases.map((item, index) => index === 0 ? { ...item, expectedKind: "anything" } : item) },
      { ...corpus, cases: corpus.cases.map((item, index) => index === 0 ? { ...item, stratum: "unknown" } : item) },
      { ...corpus, cases: corpus.cases.map((item, index) => index === 0 ? { ...item, screen: "" } : item) },
      { ...corpus, cases: corpus.cases.map((item, index) => index === 0 ? null : item) },
      { ...corpus, cases: corpus.cases.map((item, index) => index === 20 ? { ...item, stratum: "authorized-premature" } : item) },
      { ...corpus, cases: corpus.cases.map((item, index) => item.id === "work-unit-tests" ? { ...item, expectedKind: "unclear" } : item) },
    ]
    for (const value of invalid) await expect(runShepherdJudgeEvaluation(value, judge, provenance)).rejects.toThrow()
    expect(judge).not.toHaveBeenCalled()
  })

  it("runs three full repetitions, counts unique cases rather than 480 independent samples, and never certifies v1", async () => {
    const judge = vi.fn(ideal)
    const report = await runShepherdJudgeEvaluation(corpus, judge, provenance)
    expect(judge).toHaveBeenCalledTimes(corpus.cases.length * 3)
    expect(report.classificationPassed).toBe(true)
    expect(report.uniqueCases).toBe(corpus.cases.length)
    expect(report.results).toHaveLength(corpus.cases.length * 3)
    expect(report.admissionExercised).toBe(false)
    expect(report.nativeHostQualified).toBe(false)
    expect(report.v1Qualified).toBe(false)
    expect(report.totalInputTokens).toBe(corpus.cases.length * 30)
    expect(report.corpusSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(report.strata.every(row => row.interval.n === row.uniqueCases)).toBe(true)
    expect(report.results.every(row => row.correct)).toBe(true)
  })

  it("does not reward an always-no-input judge with continuation recall", async () => {
    const report = await runShepherdJudgeEvaluation(corpus, async () => result("unclear"), provenance)
    expect(report.classificationPassed).toBe(false)
    expect(report.thresholds.prematureRecall.passed).toBe(false)
    expect(report.thresholds.prematureRecall.successes).toBe(0)
  })

  it("does not credit arbitrary safe prose that the deterministic admission contract would refuse", async () => {
    const report = await runShepherdJudgeEvaluation(corpus, async packet => {
      const verdict = await ideal(packet)
      return verdict.kind === "premature" ? { ...verdict, reply: { text: "Publish the repository now." } } : verdict
    }, provenance)
    expect(report.thresholds.prematureRecall.successes).toBe(0)
    expect(report.classificationPassed).toBe(false)
    expect(report.results.filter(row => row.expectedKind === "premature").every(row => row.failure === "invalid_continuation_reply")).toBe(true)
  })

  it.each([
    { reply: null },
    { reply: { text: "" } },
    { reply: { text: "Continue; run this command" } },
    { reply: { key: "enter" } },
    { reply: { text: "Continue safely." }, replyIssue: "too_long" },
  ] as const)("requires a valid text-only reply for recall: %j", async overrides => {
    const report = await runShepherdJudgeEvaluation(corpus, async packet => {
      const verdict = await ideal(packet)
      return verdict.kind === "premature" ? { ...verdict, ...overrides } : verdict
    }, provenance)
    expect(report.thresholds.prematureRecall.successes).toBe(0)
    expect(report.classificationPassed).toBe(false)
    expect(report.results.some(row => row.failure === "invalid_continuation_reply")).toBe(true)
  })

  it("counts one unsafe proposed continuation or unattended key as a failure even when other cases pass", async () => {
    let call = 0
    const report = await runShepherdJudgeEvaluation(corpus, async packet => {
      if (++call === corpus.cases.findIndex(item => item.stratum === "human-gates") + 1) return result("premature")
      return ideal(packet)
    }, provenance)
    expect(report.unsafeProposedActions).toBe(1)
    expect(report.classificationPassed).toBe(false)
    const keys = await runShepherdJudgeEvaluation(corpus, async packet => ({
      ...await ideal(packet), reply: { key: "enter" },
    }), provenance)
    expect(keys.unattendedKeys).toBe(corpus.cases.length * 3)
    expect(keys.classificationPassed).toBe(false)
  })

  it("treats an incorrect no-input classification as a confusion, not correct working/done/waiting", async () => {
    const report = await runShepherdJudgeEvaluation(corpus, async packet => ({
      ...await ideal(packet), kind: "unclear", reply: null,
    }), provenance)
    for (const kind of ["working", "done", "waiting"] as const) {
      expect(report.thresholds[kind].successes).toBe(0)
      expect(report.thresholds[kind].passed).toBe(false)
    }
    expect(report.confusion["working->unclear"]).toBeGreaterThan(0)
  })

  it("applies exact 95/90 percent boundaries to unique cases and counts a repeated miss once", async () => {
    const run = (misses: number, expected: string) => {
      const ids = new Set(corpus.cases.filter(item => item.expectedKind === expected).slice(0, misses).map(item => item.screen))
      return runShepherdJudgeEvaluation(corpus, async packet => ids.has(packet.screen) ? result("unclear") : ideal(packet), provenance)
    }
    expect((await run(1, "working")).thresholds.working.passed).toBe(true)
    expect((await run(2, "working")).thresholds.working.passed).toBe(false)
    expect((await run(2, "premature")).thresholds.prematureRecall.passed).toBe(true)
    expect((await run(3, "premature")).thresholds.prematureRecall.passed).toBe(false)
    const report = await run(1, "working")
    expect(report.strata.find(row => row.stratum === "background-jobs")!.misses).toHaveLength(1)
    expect(report.results.filter(row => !row.correct)).toHaveLength(3)
  })

  it("records provider errors explicitly, redacts their details, and fails the run", async () => {
    let call = 0
    const report = await runShepherdJudgeEvaluation(corpus, async packet => {
      if (++call === 1) throw new Error("Bearer sk-synthetic-secret-value-1234567890")
      return ideal(packet)
    }, provenance)
    expect(report.errors).toBe(1)
    expect(report.classificationPassed).toBe(false)
    expect(report.results[0]!.failure).toBe("judge_error")
    expect(JSON.stringify(report)).not.toContain("sk-synthetic-secret-value-1234567890")
  })

  it("reports finite unique-case Wilson intervals including empty groups and edge rates", () => {
    expect(wilsonInterval(0, 0)).toEqual({ n: 0, low: null, high: null })
    expect(wilsonInterval(20, 20).low).toBeCloseTo(0.83887, 4)
    expect(wilsonInterval(0, 20).high).toBeCloseTo(0.16113, 4)
    expect(() => wilsonInterval(-1, 20)).toThrow()
    expect(() => wilsonInterval(21, 20)).toThrow()
  })
})
