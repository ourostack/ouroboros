/**
 * The assertion self-test, run in CI and before any model run: a case's pass fixture must pass every assertion it
 * names, and each fail fixture must fail at least one. A fail fixture that passes everything means an assertion is
 * vacuous, and the case is rejected, not just reported.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import { ASSERTIONS, evaluate } from "./assertions"
import { validateCase, type Case, type Observation } from "./domain/case"

function grade(c: Case, obs: Observation): { failed: string[] } | { error: string } {
  try {
    return { failed: evaluate(c, obs).checks.filter(check => !check.ok).map(check => check.name) }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

export function selfTest(c: Case): { ok: boolean; problems: string[] } {
  emitNervesEvent({ component: "eval", event: "eval.self_test_start", message: "self-testing an eval case", meta: { caseId: c.id } })
  const unknown = c.assertions.filter(ref => !Object.hasOwn(ASSERTIONS, ref.name)).map(ref => `unknown assertion ${ref.name}`)
  const problems = [...unknown]
  if (unknown.length === 0) {
    const pass = grade(c, c.fixtures.pass)
    if ("error" in pass) problems.push(`pass fixture: ${pass.error}`)
    else if (pass.failed.length > 0) problems.push(`pass fixture fails ${pass.failed.join(", ")}`)
    for (const [key, fixture] of Object.entries(c.fixtures.fail)) {
      const fail = grade(c, fixture)
      if ("error" in fail) problems.push(`fail fixture ${key}: ${fail.error}`)
      else if (fail.failed.length === 0) problems.push(`fail fixture ${key} passes every assertion, so an assertion is vacuous`)
    }
  }
  if (problems.length > 0) {
    emitNervesEvent({ component: "eval", level: "error", event: "eval.self_test_error",
      message: "eval case failed its self-test", meta: { caseId: c.id, problems } })
  }
  emitNervesEvent({ component: "eval", event: "eval.self_test_end", message: "self-tested an eval case",
    meta: { caseId: c.id, ok: problems.length === 0 } })
  return { ok: problems.length === 0, problems }
}

/** Every `*.json` case in `dir`, sorted by file name and validated; throws naming the file at fault. */
export function loadCases(dir: string): Case[] {
  emitNervesEvent({ component: "eval", event: "eval.load_cases_start", message: "loading eval cases", meta: { dir } })
  const files = readdirSync(dir).filter(name => name.endsWith(".json")).sort()
  const fail = (message: string): never => {
    emitNervesEvent({ component: "eval", level: "error", event: "eval.load_cases_error",
      message: "eval cases failed to load", meta: { dir, reason: message } })
    throw new Error(message)
  }
  if (files.length === 0) fail(`no case files in ${dir}`)
  const ids = new Set<string>()
  const cases = files.map(name => {
    let c: Case
    try {
      c = validateCase(JSON.parse(readFileSync(join(dir, name), "utf8")))
    } catch (error) {
      return fail(`${name}: ${(error as Error).message}`)
    }
    if (ids.has(c.id)) fail(`duplicate case id ${c.id} in ${name}`)
    ids.add(c.id)
    return c
  })
  emitNervesEvent({ component: "eval", event: "eval.load_cases_end", message: "loaded eval cases", meta: { dir, count: cases.length } })
  return cases
}
