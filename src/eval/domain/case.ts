/**
 * A replay eval case: a synthetic conversation prefix, the sandbox seed it runs against (fake services, their
 * state, and a ground-truth label for every fixture file) and the named machine-state assertions that judge a run.
 * Pure data and validation: no I/O, model or transport. A case carries one `pass` observation and one `fail`
 * observation per known bad behaviour, so its assertions can be tested before anything is spent on a model.
 */
import { emitNervesEvent } from "../../nerves/runtime"

/** What a fixture file really is, keyed by its SHA-256: the work, which edition, and whether a person can read it. */
export type FixtureLabel = { sha256: string; work: string; edition: string; readable: boolean }
export type SeedBook = { id: number; title: string; sha256: string }
export type Seed = {
  library: SeedBook[]
  libgen: FixtureLabel[]
  labels: FixtureLabel[]
  deleteAllowed: boolean
  /** SHA-256 of every file seeded into the writable mounts before the turn. */
  disk: string[]
}
export type TraceCall = { kind: "call"; name: string; args: string; result: string }
export type TraceReply = { kind: "reply"; text: string }
/** What a run did, read back from sources the agent never wrote. */
export type Observation = {
  timeline: Array<TraceCall | TraceReply>
  finalReply: string
  library: SeedBook[]
  mail: Array<{ to: string; attachments: string[] }>
  created: Array<{ path: string; sha256: string }>
  outcome: string
  steps: number
  /** Readability of files no label covers, graded on the host by the pinned oracle checker. */
  oracle: Record<string, boolean>
}
export type AssertionRef = { name: string; args?: Record<string, unknown> }
export type Case = {
  schemaVersion: 1
  id: string
  actionIds: string[]
  bundle: { include: string[] }
  prefix: Array<{ role: "user" | "assistant"; content: string }>
  seed: Seed
  assertions: AssertionRef[]
  fixtures: { pass: Observation; fail: Record<string, Observation> }
}

const CASE_ID = /^[a-z][a-z0-9-]{0,63}$/
const SHA256 = /^[0-9a-f]{64}$/

function invalid(field: string): never {
  emitNervesEvent({ component: "eval", level: "error", event: "eval.case_invalid",
    message: "eval case failed validation", meta: { field } })
  throw new Error(`Invalid case: ${field}`)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const record = (value: unknown, field: string): Record<string, unknown> => isRecord(value) ? value : invalid(field)
const text = (value: unknown, field: string): string => typeof value === "string" ? value : invalid(field)
const nonEmpty = (value: unknown, field: string): string => text(value, field).length > 0 ? value as string : invalid(field)
const flag = (value: unknown, field: string): boolean => typeof value === "boolean" ? value : invalid(field)
const count = (value: unknown, field: string): number =>
  Number.isInteger(value) && (value as number) >= 0 ? value as number : invalid(field)
const sha256 = (value: unknown, field: string): string =>
  typeof value === "string" && SHA256.test(value) ? value : invalid(field)
function list<T>(value: unknown, field: string, each: (item: unknown, field: string) => T): T[] {
  return Array.isArray(value) ? value.map((item, index) => each(item, `${field}[${index}]`)) : invalid(field)
}

function book(value: unknown, field: string): SeedBook {
  const entry = record(value, field)
  return { id: count(entry.id, `${field}.id`), title: nonEmpty(entry.title, `${field}.title`),
    sha256: sha256(entry.sha256, `${field}.sha256`) }
}

function label(value: unknown, field: string): FixtureLabel {
  const entry = record(value, field)
  return { sha256: sha256(entry.sha256, `${field}.sha256`), work: nonEmpty(entry.work, `${field}.work`),
    edition: nonEmpty(entry.edition, `${field}.edition`), readable: flag(entry.readable, `${field}.readable`) }
}

function seed(value: unknown, field: string): Seed {
  const entry = record(value, field)
  return { library: list(entry.library, `${field}.library`, book), libgen: list(entry.libgen, `${field}.libgen`, label),
    labels: list(entry.labels, `${field}.labels`, label), deleteAllowed: flag(entry.deleteAllowed, `${field}.deleteAllowed`),
    disk: list(entry.disk, `${field}.disk`, sha256) }
}

function step(value: unknown, field: string): TraceCall | TraceReply {
  const entry = record(value, field)
  if (entry.kind === "reply") return { kind: "reply", text: text(entry.text, `${field}.text`) }
  if (entry.kind !== "call") invalid(`${field}.kind`)
  return { kind: "call", name: nonEmpty(entry.name, `${field}.name`), args: text(entry.args, `${field}.args`),
    result: text(entry.result, `${field}.result`) }
}

function oracle(value: unknown, field: string): Record<string, boolean> {
  const entries = Object.entries(record(value, field))
  return Object.fromEntries(entries.map(([hash, readable]) =>
    [sha256(hash, `${field}.${hash}`), flag(readable, `${field}.${hash}`)]))
}

export function validateObservation(value: unknown, field = "observation"): Observation {
  const entry = record(value, field)
  return {
    timeline: list(entry.timeline, `${field}.timeline`, step),
    finalReply: text(entry.finalReply, `${field}.finalReply`),
    library: list(entry.library, `${field}.library`, book),
    mail: list(entry.mail, `${field}.mail`, (item, at) => {
      const message = record(item, at)
      return { to: nonEmpty(message.to, `${at}.to`), attachments: list(message.attachments, `${at}.attachments`, sha256) }
    }),
    created: list(entry.created, `${field}.created`, (item, at) => {
      const file = record(item, at)
      return { path: nonEmpty(file.path, `${at}.path`), sha256: sha256(file.sha256, `${at}.sha256`) }
    }),
    outcome: nonEmpty(entry.outcome, `${field}.outcome`),
    steps: count(entry.steps, `${field}.steps`),
    oracle: oracle(entry.oracle, `${field}.oracle`),
  }
}

/** Checks every field of a parsed case and returns it typed; throws an `Error` naming the first bad field. */
export function validateCase(value: unknown): Case {
  const entry = record(value, "case")
  if (entry.schemaVersion !== 1) invalid("schemaVersion")
  const id = text(entry.id, "id")
  if (!CASE_ID.test(id)) invalid("id")
  const bundle = record(entry.bundle, "bundle")
  const assertions = list(entry.assertions, "assertions", (item, at): AssertionRef => {
    const ref = record(item, at)
    const name = nonEmpty(ref.name, `${at}.name`)
    return ref.args === undefined ? { name } : { name, args: record(ref.args, `${at}.args`) }
  })
  if (assertions.length === 0) invalid("assertions")
  const fixtures = record(entry.fixtures, "fixtures")
  const failEntries = Object.entries(record(fixtures.fail, "fixtures.fail"))
  if (failEntries.length === 0) invalid("fixtures.fail")
  return {
    schemaVersion: 1,
    id,
    actionIds: list(entry.actionIds, "actionIds", nonEmpty),
    bundle: { include: list(bundle.include, "bundle.include", nonEmpty) },
    prefix: list(entry.prefix, "prefix", (item, at) => {
      const message = record(item, at)
      if (message.role !== "user" && message.role !== "assistant") invalid(`${at}.role`)
      return { role: message.role as "user" | "assistant", content: text(message.content, `${at}.content`) }
    }),
    seed: seed(entry.seed, "seed"),
    assertions,
    fixtures: {
      pass: validateObservation(fixtures.pass, "fixtures.pass"),
      fail: Object.fromEntries(failEntries.map(([key, fixture]) => [key, validateObservation(fixture, `fixtures.fail.${key}`)])),
    },
  }
}
