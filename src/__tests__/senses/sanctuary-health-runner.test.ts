import { describe, expect, it, vi } from "vitest"

import { runSanctuaryHealthHabit } from "../../senses/sanctuary-health-runner"

describe("native Sanctuary health habit", () => {
  it("submits bounded incident evidence and never loads Telegram credentials or runs a model", async () => {
    const sweep = vi.fn(async () => ({
      message: "legacy detector prose must not be sent",
      deliveryId: "legacy-delivery",
      observationRevision: "sweep-rev-1",
      transition: "changed" as const,
      incidents: [{ id: "container:jellyfin:stopped", summary: "Jellyfin is stopped" }],
    }))
    const submitEvidence = vi.fn(async () => ({ shouldWake: true }))
    const recordEvidence = vi.fn(() => ({ shouldWake: false }))
    const credentials = vi.fn()
    const createApi = vi.fn()
    const runPrivateTurn = vi.fn()

    await expect(runSanctuaryHealthHabit("sanctuary", {
      createSweep: () => Object.assign(sweep, {}),
      submitEvidence,
      recordEvidence,
      credentials,
      createApi,
      runPrivateTurn,
    })).resolves.toEqual({
      ok: true,
      message: "health evidence submitted",
      data: { incidentCount: 1, submitted: 2, wakesRequested: 1 },
    })

    expect(recordEvidence).toHaveBeenCalledWith({
      agent: "sanctuary",
      source: "sanctuary-health",
      eventType: "health.observed",
      eventId: "container:jellyfin:stopped",
      observationRevision: "sweep-rev-1",
      transition: "changed",
      summary: "Jellyfin is stopped",
      evidence: ["Jellyfin is stopped"],
      priority: "high",
    })
    expect(submitEvidence).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "health.sweep_observed",
      eventId: "sweep",
      evidence: ["container:jellyfin:stopped: Jellyfin is stopped"],
    }))
    expect(credentials).not.toHaveBeenCalled()
    expect(createApi).not.toHaveBeenCalled()
    expect(runPrivateTurn).not.toHaveBeenCalled()
  })

  it("records recovery evidence for incidents absent from the latest sweep", async () => {
    const submitEvidence = vi.fn(async () => ({ shouldWake: true }))
    const recordEvidence = vi.fn(() => ({ shouldWake: false }))
    await runSanctuaryHealthHabit("sanctuary", {
      createSweep: () => Object.assign(vi.fn(async () => ({
        message: null,
        observationRevision: "sweep-rev-2",
        transition: "recovered" as const,
        incidents: [],
        recovered: [{ id: "endpoint:jellyfin", summary: "Jellyfin was unavailable" }],
      })), {}),
      submitEvidence,
      recordEvidence,
    })

    expect(recordEvidence).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "endpoint:jellyfin", transition: "recovered", evidence: ["recovered: Jellyfin was unavailable"],
    }))
    expect(submitEvidence).toHaveBeenCalledWith(expect.objectContaining({ eventId: "sweep", transition: "recovered" }))
  })

  it("does no paid or delivery work when the sweep has no changed evidence", async () => {
    const submitEvidence = vi.fn()
    await expect(runSanctuaryHealthHabit("sanctuary", {
      createSweep: () => Object.assign(vi.fn(async () => ({ message: null, incidents: [], recovered: [] })), {}),
      submitEvidence,
    })).resolves.toMatchObject({ data: { incidentCount: 0, submitted: 0, wakesRequested: 0 } })
    expect(submitEvidence).not.toHaveBeenCalled()
  })

  it("bounds a large correlated wake while preserving every individual receipt", async () => {
    const incidents = Array.from({ length: 17 }, (_, index) => ({ id: `container:${index}`, summary: `Container ${index} is unavailable` }))
    const submitEvidence = vi.fn(async () => ({ shouldWake: false }))
    const recordEvidence = vi.fn(() => ({ shouldWake: false }))
    const result = await runSanctuaryHealthHabit("sanctuary", {
      createSweep: () => Object.assign(vi.fn(async () => ({ message: null, observationRevision: "sweep-rev-large", incidents })), {}),
      submitEvidence,
      recordEvidence,
    })

    expect(recordEvidence).toHaveBeenCalledTimes(17)
    expect(recordEvidence).toHaveBeenCalledWith(expect.objectContaining({ observationRevision: "sweep-rev-large", transition: "changed" }))
    expect(submitEvidence).toHaveBeenCalledWith(expect.objectContaining({
      transition: "unchanged",
      summary: "Sanctuary health sweep observed 17 incident transitions.",
      evidence: expect.arrayContaining(["1 additional transitions omitted from this bounded wake; inspect individual receipts."]),
    }))
    expect(result.data).toEqual({ incidentCount: 17, submitted: 18, wakesRequested: 0 })
  })
})
