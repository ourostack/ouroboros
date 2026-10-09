import { describe, expect, it } from "vitest"
import { annotateContainers, desiredContainerState, STOPPED_ON_PURPOSE_NOTE } from "../../repertoire/sanctuary-container-policy"

const entry = (value: string, expiresAt?: string) => ({ value, provenance: "stated" as const, version: 1, source: "test", ...(expiresAt ? { expiresAt } : {}) })
const NOW = Date.parse("2026-10-09T00:00:00Z")

describe("desiredContainerState", () => {
  const policy = { desiredStates: {
    "container:calibre": entry("intentionally_off"), "container:calibre-web": entry(" ON "), "container:old": entry("off", "2026-01-01T00:00:00Z"),
    "container:future": entry("off", "2027-01-01T00:00:00Z"), "container:odd": entry("maybe"),
  } }
  it("reads on and off values, and ignores expired, unknown and missing entries", () => {
    expect(desiredContainerState(policy, "calibre", NOW)).toBe("stopped")
    expect(desiredContainerState(policy, "calibre-web", NOW)).toBe("running")
    expect(desiredContainerState(policy, "future", NOW)).toBe("stopped")
    expect(desiredContainerState(policy, "old", NOW)).toBeNull()
    expect(desiredContainerState(policy, "odd", NOW)).toBeNull()
    expect(desiredContainerState(policy, "absent", NOW)).toBeNull()
    expect(desiredContainerState(null, "calibre", NOW)).toBeNull()
  })
})

describe("annotateContainers", () => {
  const policy = { desiredStates: { "container:calibre": entry("off"), "container:calibre-web": entry("on"), "container:jellyfin": entry("on"), "container:sonarr": entry("off") } }
  const list = (containers: unknown[]) => ({ ok: true, data: { containers, truncated: false } })
  it("marks a policy-stopped container as stopped on purpose and tags calibre-web as Books", () => {
    const result = annotateContainers(list([
      { name: "calibre", state: "created" }, { name: "calibre-web", state: "running" }, { name: "plain", state: "running" },
    ]), policy, NOW)
    expect(result.data.containers).toEqual([
      { name: "calibre", state: "created", desired: "stopped", note: STOPPED_ON_PURPOSE_NOTE },
      { name: "calibre-web", state: "running", desired: "running", serves: "Books" },
      { name: "plain", state: "running" },
    ])
    expect(result.data.truncated).toBe(false)
  })
  it("flags a container that disagrees with the policy without telling the model to fix it", () => {
    const result = annotateContainers(list([{ name: "sonarr", state: "running" }, { name: "jellyfin", state: "exited" }]), policy, NOW)
    expect(result.data.containers[0]).toMatchObject({ desired: "stopped", note: expect.stringContaining("do not stop it yourself") })
    expect(result.data.containers[1]).toMatchObject({ desired: "running", note: "the steward policy wants this running but it is not" })
  })
  it("still tags Books with no policy, and tolerates malformed entries", () => {
    expect(annotateContainers(list([{ name: "calibre-web", state: "running" }, { state: 1 }]), null, NOW).data.containers).toEqual([{ name: "calibre-web", state: "running", serves: "Books" }, { state: 1 }])
  })
  it("returns failures and other shapes unchanged", () => {
    const failed = { ok: false, error: { code: "x" } }
    expect(annotateContainers(failed, policy, NOW)).toBe(failed)
    expect(annotateContainers(null, policy, NOW)).toBeNull()
    const odd = { ok: true, data: { containers: "no" } }
    expect(annotateContainers(odd, policy, NOW)).toBe(odd)
  })
})
