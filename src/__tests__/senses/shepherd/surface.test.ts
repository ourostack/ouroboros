import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FriendStore } from "@ouro.bot/friends"
import { resolveExistingLocalOwner, listShepherdTargets, validateShepherdTarget, localShepherdFriendStore, machineShepherdHost, authorizedShepherdTargets } from "../../../senses/shepherd/surface"
import type { ShepherdHost } from "../../../senses/shepherd/host"
import { registerGlobalLogSink, type LogEvent } from "../../../nerves"

const runtime = vi.hoisted(() => ({
  enabled: vi.fn(() => true),
  config: vi.fn((): any => ({ ok: true, config: {} })),
  connection: vi.fn((): any => ({ ok: true, connection: { host: "cmux", socketPath: "/test.sock", auth: { mode: "test" } } })),
  host: vi.fn((): any => ({ name: "cmux", list: async () => [] })),
  store: vi.fn((): any => ({})),
}))
vi.mock("../../../heart/identity", () => ({ getAgentBundlesRoot: () => "/test-bundles" }))
vi.mock("../../../heart/runtime-credentials", () => ({ readMachineRuntimeCredentialConfig: runtime.config }))
vi.mock("../../../heart/shepherd-config", () => ({ resolveShepherdConnection: runtime.connection }))
vi.mock("../../../repertoire/tools-shepherd", () => ({ shepherdToolsEnabled: runtime.enabled }))
vi.mock("../../../senses/shepherd/host", () => ({ createShepherdHost: runtime.host }))
vi.mock("@ouro.bot/friends", async original => ({
  ...await original<typeof import("@ouro.bot/friends")>(),
  machineOwnerUsername: () => "ari",
  FileFriendStore: vi.fn().mockImplementation(function () { return runtime.store() }),
}))

const id = "11111111-1111-4111-8111-111111111111"
function host() {
  let sessions: any[] = [{ id, ref: "surface:1", workspace: "workspace-id", workspaceTitle: "work",
    title: "tab", agent: "Copilot", cwd: "/repo", tty: "/dev/ttys009", focused: false }]
  const value = { name: "cmux", list: async () => sessions } as ShepherdHost
  return { value, change: (next: any[]) => { sessions = next } }
}
function store(records: any[]) {
  return {
    findByExternalId: async (provider: string, externalId: string) => records.find(f => f.externalIds.some((e: any) => e.provider === provider && e.externalId === externalId)) ?? null,
    listAll: async () => records,
    create: vi.fn(() => { throw new Error("must never create") }),
    put: vi.fn(() => { throw new Error("must never promote") }),
  } as unknown as FriendStore
}
const owner = { id: "owner", name: "Ari", trustLevel: "family", externalIds: [{ provider: "local", externalId: "ari", linkedAt: "2026-10-13" }] }

describe("local Shepherd surface contract", () => {
  beforeEach(() => {
    runtime.enabled.mockReturnValue(true)
    runtime.config.mockReturnValue({ ok: true, config: {} })
    runtime.connection.mockReturnValue({ ok: true, connection: { host: "cmux", socketPath: "/test.sock", auth: { mode: "test" } } })
    runtime.host.mockReturnValue({ name: "cmux", list: async () => [] })
    runtime.store.mockReturnValue(store([owner]))
  })
  it("uses the existing OS local-family identity without creating or promoting", async () => {
    await expect(resolveExistingLocalOwner(store([owner]), "ari")).resolves.toBe("owner")
    await expect(resolveExistingLocalOwner(store([owner]), "someone")).rejects.toThrow("local-family")
    await expect(resolveExistingLocalOwner(store([{ ...owner, trustLevel: "stranger" }]), "ari")).rejects.toThrow("family")
    await expect(resolveExistingLocalOwner(store([owner]), null)).rejects.toThrow("unavailable")
    await expect(resolveExistingLocalOwner(store([owner]))).resolves.toBe("owner")
    await expect(resolveExistingLocalOwner(store([{ ...owner, admissionState: "revoked" }]), "ari")).rejects.toThrow("family")
    const withoutList = store([])
    withoutList.listAll = undefined
    await expect(resolveExistingLocalOwner(withoutList, "ari")).rejects.toThrow("missing")
    await expect(resolveExistingLocalOwner(store([{ ...owner, externalIds: [{ provider: "local", externalId: "ari@old" }] }]), "ari")).resolves.toBe("owner")
    await expect(resolveExistingLocalOwner(store([
      { ...owner, externalIds: [{ provider: "local", externalId: "ari@old" }] },
      { ...owner, id: "other", externalIds: [{ provider: "local", externalId: "ari@other" }] },
    ]), "ari")).rejects.toThrow("ambiguous")
  })
  it("validates exact UUIDs and rejects reuse of a short ref after disappearance", async () => {
    const live = host()
    expect(await listShepherdTargets(live.value)).toEqual([{ id, host: "cmux", label: "Copilot / /repo / work / tab", displayLabel: "tab", selected: false }])
    expect(await listShepherdTargets(live.value, "/dev/ttys009")).toEqual([])
    expect(await listShepherdTargets(live.value, "/dev/ttys008")).toEqual([{ id, host: "cmux", label: "Copilot / /repo / work / tab", displayLabel: "tab", selected: false }])
    const pinned = await validateShepherdTarget(live.value, id)
    live.change([{ id: "22222222-2222-4222-8222-222222222222", ref: "surface:1", title: "replacement", agent: "Codex" }])
    await expect(validateShepherdTarget(live.value, pinned.id)).rejects.toThrow("unavailable")
    await expect(validateShepherdTarget(live.value, "surface:1")).rejects.toThrow("UUID")
    live.change([{ id, agent: null }])
    await expect(listShepherdTargets(live.value)).resolves.toEqual([])
    live.change([{ id: "surface:1", agent: "Copilot" }, { id, agent: "Codex", title: "tab\n\u001b\b\u009b" }])
    await expect(listShepherdTargets(live.value)).resolves.toEqual([{ id, host: "cmux", label: "Codex / tab", displayLabel: "tab", selected: false }])
    await expect(listShepherdTargets(live.value, "/dev/ttys009")).resolves.toEqual([])
  })

  it("uses only an enabled agent and its authenticated machine cmux connection", async () => {
    expect(() => localShepherdFriendStore("../escape")).toThrow("safe agent")
    expect(localShepherdFriendStore("ouro")).toBeDefined()
    expect(machineShepherdHost("ouro").name).toBe("cmux")
    expect(() => machineShepherdHost("../escape")).toThrow("enabled")
    runtime.enabled.mockReturnValue(false)
    expect(() => machineShepherdHost("ouro")).toThrow("enabled")
    runtime.enabled.mockReturnValue(true)
    runtime.config.mockReturnValue({ ok: false })
    expect(() => machineShepherdHost("ouro")).toThrow("configuration")
    runtime.config.mockReturnValue({ ok: true, config: {} })
    runtime.connection.mockReturnValue({ ok: false, error: "machine connection unavailable" })
    expect(() => machineShepherdHost("ouro")).toThrow("machine connection unavailable")
    runtime.connection.mockReturnValue({ ok: true, connection: { host: "herdr" } })
    expect(() => machineShepherdHost("ouro")).toThrow("cmux")
  })

  it("offers short human labels and an advisory current-session hint without exposing paths or UUIDs", async () => {
    const live = host()
    live.change([{ id, agent: "Copilot", cwd: "/Users/ari/code/project",
      workspaceTitle: "project", title: "Ship session attention - GitHub Copilot", selected: true }])
    const targets = await listShepherdTargets(live.value)
    expect(targets[0]).toMatchObject({
      displayLabel: "Ship session attention - GitHub Copilot", selected: true,
    })
    expect(targets[0]!.displayLabel).not.toContain("/Users")
    expect(targets[0]!.displayLabel).not.toContain(id)
    live.change([{ id, agent: "Codex", cwd: "/private/repo", title: "/private/repo", workspaceTitle: id }])
    expect((await listShepherdTargets(live.value))[0]).toMatchObject({ displayLabel: "Codex session", selected: false })
  })

  it("authorizes the daemon's target listing only for the existing local owner", async () => {
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink(event => events.push(event))
    try {
      await expect(authorizedShepherdTargets("ouro", "wrong")).rejects.toThrow("OS user's")
      const live = host()
      runtime.host.mockReturnValue(live.value)
      await expect(authorizedShepherdTargets("ouro", "owner")).resolves.toEqual([{ id, host: "cmux", label: "Copilot / /repo / work / tab", displayLabel: "tab", selected: false }])
      await expect(authorizedShepherdTargets("ouro", "owner", "/dev/ttys009")).resolves.toEqual([])
      expect(events.filter(event => event.event === "senses.shepherd_targets_resolved").map(event => event.meta)).toEqual([{ agent: "ouro", count: 1 }, { agent: "ouro", count: 0 }])
    } finally { unregister() }
  })
})
