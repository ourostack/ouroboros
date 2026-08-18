import * as fs from "node:fs"
import * as path from "node:path"

import { describe, expect, it } from "vitest"

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../../..", relativePath), "utf8")
}

function expectOuterLease(sourceText: string, facts: {
  derivePath: string
  load: string
  provider: string
  persist: string
  delivery: string
}): void {
  const derive = sourceText.indexOf(facts.derivePath)
  const acquire = sourceText.indexOf("await withSessionTurnLease", derive)
  const load = sourceText.indexOf(facts.load, acquire)
  const provider = sourceText.indexOf(facts.provider, load)
  const persist = sourceText.indexOf(facts.persist, provider)
  const delivery = sourceText.indexOf(facts.delivery, persist)
  expect({ derive, acquire, load, provider, persist, delivery }).toEqual({
    derive: expect.any(Number),
    acquire: expect.any(Number),
    load: expect.any(Number),
    provider: expect.any(Number),
    persist: expect.any(Number),
    delivery: expect.any(Number),
  })
  expect(derive).toBeGreaterThanOrEqual(0)
  expect(acquire).toBeGreaterThan(derive)
  expect(load).toBeGreaterThan(acquire)
  expect(provider).toBeGreaterThan(load)
  expect(persist).toBeGreaterThan(provider)
  expect(delivery).toBeGreaterThan(persist)
}

describe("real session-turn lease callers", () => {
  it("shared-turn owns one lease from path derivation through load, provider, persist, and delivery", () => {
    expectOuterLease(source("src/senses/shared-turn.ts"), {
      derivePath: "const sessPath =",
      load: "loadSession(sessPath)",
      provider: "handleInboundTurn({",
      persist: "persistPromise",
      delivery: "deliverPending(",
    })
  })

  it("CLI replaces the terminal-lifetime lock with the shared turn lease around load through delivery", () => {
    const text = source("src/senses/cli.ts")
    expect(text).not.toContain("acquireSessionLock(`${sessPath}.lock`")
    expectOuterLease(text, {
      derivePath: "const sessPath =",
      load: "loadSession(sessPath)",
      provider: "handleInboundTurn({",
      persist: "postTurnPersist(",
      delivery: "callbacks",
    })
  })

  it("Teams owns the shared turn lease before session load until send completes", () => {
    expectOuterLease(source("src/senses/teams.ts"), {
      derivePath: "const sessPath =",
      load: "loadSession(sessPath)",
      provider: "handleInboundTurn({",
      persist: "deferPostTurnPersist(",
      delivery: "sendActivity(",
    })
  })

  it("BlueBubbles moves its early save inside the lease and retains it through accepted delivery", () => {
    const text = source("src/senses/bluebubbles/index.ts")
    const derive = text.indexOf("const sessPath =")
    const acquire = text.indexOf("await withSessionTurnLease", derive)
    const load = text.indexOf("resolvedDeps.loadSession(sessPath)", acquire)
    const earlySave = text.indexOf("resolvedDeps.saveSession(", load)
    const provider = text.indexOf("handleInboundTurn({", earlySave)
    const persist = text.indexOf("postTurnPersist(", provider)
    const acceptedDelivery = text.indexOf("accepted", persist)
    expect(derive).toBeGreaterThanOrEqual(0)
    expect(acquire).toBeGreaterThan(derive)
    expect(load).toBeGreaterThan(acquire)
    expect(earlySave).toBeGreaterThan(load)
    expect(provider).toBeGreaterThan(earlySave)
    expect(persist).toBeGreaterThan(provider)
    expect(acceptedDelivery).toBeGreaterThan(persist)
  })

  it("private-runtime owns the lease before load through pipeline persistence and return delivery", () => {
    expectOuterLease(source("src/senses/private-runtime.ts"), {
      derivePath: "sessionFilePath",
      load: "loadSession(sessionFilePath)",
      provider: "handleInboundTurn({",
      persist: "deferPostTurnPersist(",
      delivery: "return",
    })
  })

  it("all canonical context mutations use the durable transaction writer instead of direct replacement", () => {
    const text = source("src/mind/context.ts")
    expect(text).toContain("from \"./session-transaction\"")
    expect(text).not.toContain("fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2))")
    for (const mutation of ["saveSession", "appendSyntheticAssistantMessage", "postTurnPersist", "deleteSession"]) {
      const start = text.indexOf(`export function ${mutation}`)
      expect(start, `${mutation} must remain an exported transaction-routed mutation`).toBeGreaterThanOrEqual(0)
      expect(text.indexOf("writeSessionTransaction", start), `${mutation} must route through the transaction writer`).toBeGreaterThan(start)
    }
  })
})
