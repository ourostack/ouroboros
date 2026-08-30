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
    const credentials = vi.fn()
    const createApi = vi.fn()
    const runPrivateTurn = vi.fn()

    await expect(runSanctuaryHealthHabit("sanctuary", {
      createSweep: () => Object.assign(sweep, {}),
      submitEvidence,
      credentials,
      createApi,
      runPrivateTurn,
    })).resolves.toEqual({
      ok: true,
      message: "health evidence submitted",
      data: { incidentCount: 1, submitted: 1, wakesRequested: 1 },
    })

    expect(submitEvidence).toHaveBeenCalledWith({
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
    expect(submitEvidence).toHaveBeenCalledTimes(1)
    expect(credentials).not.toHaveBeenCalled()
    expect(createApi).not.toHaveBeenCalled()
    expect(runPrivateTurn).not.toHaveBeenCalled()
  })

  it("records recovery evidence for incidents absent from the latest sweep", async () => {
    const submitEvidence = vi.fn(async () => ({ shouldWake: true }))
    await runSanctuaryHealthHabit("sanctuary", {
      createSweep: () => Object.assign(vi.fn(async () => ({
        message: null,
        observationRevision: "sweep-rev-2",
        transition: "recovered" as const,
        incidents: [],
        recovered: [{ id: "endpoint:jellyfin", summary: "Jellyfin was unavailable" }],
      })), {}),
      submitEvidence,
    })

    expect(submitEvidence).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "endpoint:jellyfin", transition: "recovered", evidence: ["recovered: Jellyfin was unavailable"],
    }))
    expect(submitEvidence).toHaveBeenCalledTimes(1)
  })

  it("keeps each current incident's own transition when another incident recovers", async () => {
    const submitEvidence = vi.fn(async () => ({ shouldWake: true }))
    await runSanctuaryHealthHabit("sanctuary", {
      createSweep: () => Object.assign(vi.fn(async () => ({
        message: null,
        observationRevision: "aggregate-rev",
        transition: "changed" as const,
        incidents: [{ id: "incident:a", summary: "A is still unavailable", observationRevision: "rev-a", transition: "unchanged" as const }],
        recovered: [{ id: "incident:b", summary: "B was unavailable", observationRevision: "rev-b" }],
      })), {}),
      submitEvidence,
    })

    expect(submitEvidence).toHaveBeenCalledWith(expect.objectContaining({ eventId: "incident:a", observationRevision: "rev-a", transition: "unchanged" }))
    expect(submitEvidence).toHaveBeenCalledWith(expect.objectContaining({ eventId: "incident:b", observationRevision: "rev-b", transition: "recovered" }))
  })

  it("does no paid or delivery work when the sweep has no changed evidence", async () => {
    const submitEvidence = vi.fn()
    await expect(runSanctuaryHealthHabit("sanctuary", {
      createSweep: () => Object.assign(vi.fn(async () => ({ message: null, incidents: [], recovered: [] })), {}),
      submitEvidence,
    })).resolves.toMatchObject({ data: { incidentCount: 0, submitted: 0, wakesRequested: 0 } })
    expect(submitEvidence).not.toHaveBeenCalled()
  })

  it("submits every canonical incident receipt while reporting one coalesced wake request", async () => {
    const incidents = Array.from({ length: 17 }, (_, index) => ({ id: `container:${index}`, summary: `Container ${index} is unavailable` }))
    const submitEvidence = vi.fn(async () => ({ shouldWake: true }))
    const result = await runSanctuaryHealthHabit("sanctuary", {
      createSweep: () => Object.assign(vi.fn(async () => ({ message: null, observationRevision: "sweep-rev-large", incidents })), {}),
      submitEvidence,
    })

    expect(submitEvidence).toHaveBeenCalledTimes(17)
    expect(submitEvidence).toHaveBeenCalledWith(expect.objectContaining({ observationRevision: "sweep-rev-large", transition: "changed" }))
    expect(result.data).toEqual({ incidentCount: 17, submitted: 17, wakesRequested: 1 })
  })
})
