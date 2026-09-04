import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"

// ── Mock continuity store modules ────────────────────────────────

const mockReadRecentEpisodes = vi.fn()
const mockEmitEpisode = vi.fn()
const mockReadActiveCares = vi.fn()
const mockReadCares = vi.fn()
const mockCreateCare = vi.fn()
const mockUpdateCare = vi.fn()
const mockResolveCare = vi.fn()
const mockBindCareIncident = vi.fn()
const mockResolveCareIncident = vi.fn()
const mockUpsertCareForIncident = vi.fn()
const mockReadPresence = vi.fn()
const mockReadPeerPresence = vi.fn()
const mockCaptureIntention = vi.fn()
const mockResolveIntention = vi.fn()
const mockDismissIntention = vi.fn()
const mockGetExternalEventRoot = vi.fn(() => "/events")
const mockReadExternalEventRecord = vi.fn()
const mockClaimExternalEvent = vi.fn()
const mockCommitExternalEventDisposition = vi.fn()

vi.mock("../../arc/episodes", () => ({
  readRecentEpisodes: (...args: any[]) => mockReadRecentEpisodes(...args),
  emitEpisode: (...args: any[]) => mockEmitEpisode(...args),
}))

vi.mock("../../arc/cares", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../arc/cares")>()),
  readActiveCares: (...args: any[]) => mockReadActiveCares(...args),
  readCares: (...args: any[]) => mockReadCares(...args),
  createCare: (...args: any[]) => mockCreateCare(...args),
  updateCare: (...args: any[]) => mockUpdateCare(...args),
  resolveCare: (...args: any[]) => mockResolveCare(...args),
  bindCareIncident: (...args: any[]) => mockBindCareIncident(...args),
  resolveCareIncident: (...args: any[]) => mockResolveCareIncident(...args),
  upsertCareForIncident: (...args: any[]) => mockUpsertCareForIncident(...args),
}))

vi.mock("../../arc/presence", () => ({
  readPresence: (...args: any[]) => mockReadPresence(...args),
  readPeerPresence: (...args: any[]) => mockReadPeerPresence(...args),
}))

vi.mock("../../arc/intentions", () => ({
  captureIntention: (...args: any[]) => mockCaptureIntention(...args),
  resolveIntention: (...args: any[]) => mockResolveIntention(...args),
  dismissIntention: (...args: any[]) => mockDismissIntention(...args),
}))

vi.mock("../../heart/identity", () => ({
  getAgentRoot: vi.fn(() => "/mock/agent-root"),
  getAgentName: vi.fn(() => "ouroboros"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  loadAgentConfig: vi.fn(() => ({
    name: "ouroboros",
    humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    context: {},
  })),
  getAgentRepoWorkspacesRoot: vi.fn(() => "/mock/repo/ouroboros/state/workspaces"),
  HARNESS_CANONICAL_REPO_URL: "https://github.com/ourostack/ouroboros.git",
}))

vi.mock("../../heart/external-events/router", () => ({
  getExternalEventRoot: (...args: any[]) => mockGetExternalEventRoot(...args),
  readExternalEventRecord: (...args: any[]) => mockReadExternalEventRecord(...args),
  claimExternalEvent: (...args: any[]) => mockClaimExternalEvent(...args),
  commitExternalEventDisposition: (...args: any[]) => mockCommitExternalEventDisposition(...args),
}))

afterEach(() => vi.useRealTimers())

// Minimal mocks for tools-base dependencies
vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(""),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  mkdirSync: vi.fn(),
  statSync: vi.fn().mockReturnValue({ mtimeMs: 0 }),
  lstatSync: vi.fn().mockReturnValue({ isFile: () => true, isSymbolicLink: () => false }),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
  appendFileSync: vi.fn(),
}))

vi.mock("child_process", () => ({
  execSync: vi.fn().mockReturnValue(""),
  spawnSync: vi.fn().mockReturnValue({ stdout: "", stderr: "", status: 0 }),
}))

vi.mock("fast-glob", () => ({
  default: { sync: vi.fn().mockReturnValue([]) },
  sync: vi.fn().mockReturnValue([]),
}))

vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn().mockReturnValue([]),
  loadSkill: vi.fn().mockReturnValue(null),
}))


vi.mock("../../heart/daemon/socket-client", () => ({
  requestInnerWake: vi.fn(async () => null),
  sendDaemonCommand: vi.fn(),
  checkDaemonSocketAlive: vi.fn(),
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-daemon.sock",
}))

vi.mock("../../repertoire/coding", () => ({
  getCodingSessionManager: () => ({
    listSessions: vi.fn().mockReturnValue([]),
  }),
}))

import { baseToolDefinitions, type ToolDefinition } from "../../repertoire/tools-base"
import { validateAdvertisedToolArguments } from "../../repertoire/tool-arguments"

// ── Test helpers ─────────────────────────────────────────────────

function findTool(name: string): ToolDefinition {
  const tool = baseToolDefinitions.find((d) => d.tool.function.name === name)
  if (!tool) throw new Error(`Tool ${name} not found in baseToolDefinitions`)
  return tool
}

// ── Tests ────────────────────────────────────────────────────────

describe("continuity tools", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fs.existsSync).mockImplementation((filePath) => String(filePath).endsWith("steward.json"))
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => String(filePath).endsWith("steward.json")
      ? JSON.stringify({ schemaVersion: 1, version: 2, desiredStates: { "service:books": { value: "on", provenance: "stated", version: 2, source: "ari" }, "service:sonarr": { value: "on", provenance: "stated", version: 2, source: "ari" }, test: { value: "on", provenance: "stated", version: 2, source: "ari" } }, routineActionGrants: {}, updatedAt: "2026-08-29T00:00:00.000Z" })
      : "")
    mockReadCares.mockReturnValue([])
  })

  describe("query_episodes", () => {
    it("tool exists in baseToolDefinitions", () => {
      const tool = findTool("query_episodes")
      expect(tool).toBeDefined()
      expect(tool.tool.function.name).toBe("query_episodes")
    })

    it("returns recent episodes", async () => {
      const episodes = [
        { id: "ep-1", kind: "coding_milestone", summary: "deployed v2", timestamp: "2026-04-01T10:00:00Z", salience: "medium", relatedEntities: [], whyItMattered: "milestone" },
      ]
      mockReadRecentEpisodes.mockReturnValue(episodes)

      const tool = findTool("query_episodes")
      const result = await tool.handler({})
      expect(mockReadRecentEpisodes).toHaveBeenCalledWith("/mock/agent-root", expect.any(Object))
      expect(result).toContain("deployed v2")
    })

    it("supports limit filter", async () => {
      mockReadRecentEpisodes.mockReturnValue([])
      const tool = findTool("query_episodes")
      await tool.handler({ limit: "5" })
      expect(mockReadRecentEpisodes).toHaveBeenCalledWith("/mock/agent-root", expect.objectContaining({ limit: 5 }))
    })

    it("supports kind filter", async () => {
      mockReadRecentEpisodes.mockReturnValue([])
      const tool = findTool("query_episodes")
      await tool.handler({ kind: "coding_milestone" })
      expect(mockReadRecentEpisodes).toHaveBeenCalledWith("/mock/agent-root", expect.objectContaining({ kinds: ["coding_milestone"] }))
    })
  })

  describe("capture_episode", () => {
    it("tool exists in baseToolDefinitions", () => {
      const tool = findTool("capture_episode")
      expect(tool).toBeDefined()
    })

    it("creates agent-authored episode with minimal fields", async () => {
      const mockEpisode = { id: "ep-new", summary: "breakthrough moment", timestamp: "2026-04-02T10:00:00Z" }
      mockEmitEpisode.mockReturnValue(mockEpisode)

      const tool = findTool("capture_episode")
      const result = await tool.handler({ summary: "breakthrough moment", whyItMattered: "changed approach" })
      expect(mockEmitEpisode).toHaveBeenCalledWith(
        "/mock/agent-root",
        expect.objectContaining({
          summary: "breakthrough moment",
          whyItMattered: "changed approach",
          kind: "turning_point",
          salience: "medium",
        }),
      )
      expect(result).toContain("ep-new")
    })
  })

  describe("query_presence", () => {
    it("tool exists in baseToolDefinitions", () => {
      const tool = findTool("query_presence")
      expect(tool).toBeDefined()
    })

    it("returns self and peer presence", async () => {
      const selfPresence = { agentName: "ouroboros", availability: "active", lane: "conversation", tempo: "brief", updatedAt: "2026-04-02T10:00:00Z" }
      const peers = [{ agentName: "slugger", availability: "idle", lane: "coding", tempo: "standard", updatedAt: "2026-04-02T10:00:00Z" }]
      mockReadPresence.mockReturnValue(selfPresence)
      mockReadPeerPresence.mockReturnValue(peers)

      const tool = findTool("query_presence")
      const result = await tool.handler({})
      expect(result).toContain("ouroboros")
      expect(result).toContain("slugger")
    })
  })

  describe("query_cares", () => {
    it("tool exists in baseToolDefinitions", () => {
      const tool = findTool("query_cares")
      expect(tool).toBeDefined()
    })

    it("returns active cares by default", async () => {
      const cares = [{ id: "c-1", label: "deploy health", status: "active", salience: "high" }]
      mockReadActiveCares.mockReturnValue(cares)

      const tool = findTool("query_cares")
      const result = await tool.handler({})
      expect(result).toContain("deploy health")
    })

    it("returns all cares when status=all", async () => {
      const cares = [{ id: "c-1", label: "old care", status: "resolved" }]
      mockReadCares.mockReturnValue(cares)

      const tool = findTool("query_cares")
      const result = await tool.handler({ status: "all" })
      expect(mockReadCares).toHaveBeenCalled()
    })

    it("projects an overdue system care as stale without presenting its old assessment as current", async () => {
      vi.useFakeTimers()
      vi.setSystemTime("2026-09-01T02:17:46.315Z")
      mockReadActiveCares.mockReturnValue([{
        id: "care-docker",
        label: "Docker image disk pressure (97% critical)",
        why: "Docker image utilization was climbing toward 100%.",
        kind: "system",
        status: "active",
        salience: "high",
        steward: "mine",
        relatedFriendIds: [],
        relatedAgentIds: [],
        relatedObligationIds: [],
        relatedEpisodeIds: [],
        currentRisk: "Docker image was measured at 100%.",
        nextCheckAt: "2026-08-31T14:45:00.000Z",
        createdAt: "2026-08-31T09:00:05.599Z",
        updatedAt: "2026-08-31T14:30:36.894Z",
      }])

      const result = JSON.parse(String(await findTool("query_cares")!.handler({})))

      expect(result).toEqual([expect.objectContaining({
        id: "care-docker",
        evidenceStatus: "stale",
        recheckRequired: true,
        staleAt: "2026-08-31T14:45:00.000Z",
      })])
      expect(JSON.stringify(result)).not.toContain("climbing toward 100%")
      expect(JSON.stringify(result)).not.toContain("measured at 100%")
      expect(result[0]).not.toHaveProperty("label")
      expect(result[0]).not.toHaveProperty("why")
      expect(result[0]).not.toHaveProperty("currentRisk")
      expect(JSON.stringify(result)).not.toContain("97%")
    })

    it("leaves current system cares and non-system cares unchanged", async () => {
      vi.useFakeTimers()
      vi.setSystemTime("2026-09-01T02:17:46.315Z")
      const cares = [
        { id: "current-system", label: "Current health", kind: "system", status: "active", nextCheckAt: "2026-09-01T03:00:00.000Z", currentRisk: "Current fact" },
        { id: "project", label: "House project", kind: "project", nextCheckAt: "2026-08-31T03:00:00.000Z", currentRisk: "Still meaningful" },
      ]
      mockReadActiveCares.mockReturnValue(cares)

      const result = JSON.parse(String(await findTool("query_cares")!.handler({})))

      expect(result).toEqual(cares)
    })

    it("fails an invalid system-care next-check timestamp closed as stale", async () => {
      mockReadActiveCares.mockReturnValue([{
        id: "invalid-system",
        label: "Docker image at 100%",
        why: "Old measurement",
        kind: "system",
        status: "active",
        salience: "high",
        steward: "mine",
        nextCheckAt: "not-a-time",
        updatedAt: "2026-08-31T14:30:36.894Z",
      }])

      const result = JSON.parse(String(await findTool("query_cares")!.handler({})))

      expect(result).toEqual([expect.objectContaining({ id: "invalid-system", evidenceStatus: "stale", recheckRequired: true, staleAt: "not-a-time" })])
      expect(JSON.stringify(result)).not.toMatch(/100%|Old measurement/)
    })
  })

  describe("care_manage", () => {
    it("tool exists in baseToolDefinitions", () => {
      const tool = findTool("care_manage")
      expect(tool).toBeDefined()
      expect((tool.tool.function.parameters.properties as any).status.enum).toEqual(["active", "watching", "resolved", "dormant"])
    })

    it("creates a care when action=create", async () => {
      const mockCare = { id: "c-new", label: "new care", status: "active" }
      mockCreateCare.mockReturnValue(mockCare)

      const tool = findTool("care_manage")
      const result = await tool.handler({ action: "create", label: "new care", why: "matters to me", salience: "high", kind: "project", stewardship: "mine" })
      expect(mockCreateCare).toHaveBeenCalled()
      expect(result).toContain("c-new")
    })

    it("updates a care when action=update", async () => {
      const mockCare = { id: "c-1", label: "updated", status: "active" }
      mockUpdateCare.mockReturnValue(mockCare)

      const tool = findTool("care_manage")
      const result = await tool.handler({ action: "update", id: "c-1", label: "updated" })
      expect(mockUpdateCare).toHaveBeenCalledWith("/mock/agent-root", "c-1", expect.objectContaining({ label: "updated" }))
    })

    it("resolves a care when action=resolve", async () => {
      const mockCare = { id: "c-1", label: "resolved care", status: "resolved" }
      mockResolveCare.mockReturnValue(mockCare)

      const tool = findTool("care_manage")
      const result = await tool.handler({ action: "resolve", id: "c-1" })
      expect(mockResolveCare).toHaveBeenCalledWith("/mock/agent-root", "c-1")
    })

    it("binds a machine incident to an existing care with CAS", async () => {
      mockBindCareIncident.mockReturnValue({ id: "c-1", incidentBindings: [{ source: "sanctuary-health", incidentKey: "container:books" }] })
      const tool = findTool("care_manage")
      await tool.handler({
        action: "bind_incident",
        id: "c-1",
        source: "sanctuary-health",
        incidentKey: "container:books",
        classifiedRevision: "rev-2",
        correlationKey: "library",
        expectedUpdatedAt: "2026-08-29T17:00:00.000Z",
      })
      expect(mockBindCareIncident).toHaveBeenCalledWith("/mock/agent-root", "c-1", {
        source: "sanctuary-health",
        incidentKey: "container:books",
        classifiedRevision: "rev-2",
        correlationKey: "library",
      }, { expectedUpdatedAt: "2026-08-29T17:00:00.000Z" })
    })

    it("binds an incident without an optional correlation key", async () => {
      mockBindCareIncident.mockReturnValue({ id: "c-1" })
      const tool = findTool("care_manage")
      await tool.handler({ action: "bind_incident", id: "c-1", source: "guard", incidentKey: "usenet", classifiedRevision: "rev-1", expectedUpdatedAt: "now" })
      expect(mockBindCareIncident).toHaveBeenCalledWith("/mock/agent-root", "c-1", { source: "guard", incidentKey: "usenet", classifiedRevision: "rev-1" }, { expectedUpdatedAt: "now" })
    })

    it("resolves one care incident without closing the care", async () => {
      mockResolveCareIncident.mockReturnValue({ id: "c-1", status: "active" })
      const tool = findTool("care_manage")
      await tool.handler({ action: "resolve_incident", id: "c-1", source: "sanctuary-health", incidentKey: "container:books", expectedUpdatedAt: "2026-08-29T17:00:00.000Z" })
      expect(mockResolveCareIncident).toHaveBeenCalledWith("/mock/agent-root", "c-1", {
        source: "sanctuary-health",
        incidentKey: "container:books",
        expectedUpdatedAt: "2026-08-29T17:00:00.000Z",
      })
      expect(mockResolveCare).not.toHaveBeenCalled()
    })

    it("forwards the atomic safe-display replacement with incident resolution", async () => {
      mockResolveCareIncident.mockReturnValue({ id: "c-docker", status: "resolved" })
      await findTool("care_manage").handler({
        action: "resolve_incident", id: "c-docker", source: "sanctuary-health::Docker_critical_image_disk_utilization",
        incidentKey: "docker-image-disk-100pct-20260831T1427Z", expectedUpdatedAt: "v1",
        label: "Docker image disk utilization", why: "Verified from current Unraid notifications.", currentRisk: "", nextCheckAt: "",
      })
      expect(mockResolveCareIncident).toHaveBeenCalledWith("/mock/agent-root", "c-docker", expect.objectContaining({
        expectedUpdatedAt: "v1",
        display: { label: "Docker image disk utilization", why: "Verified from current Unraid notifications.", currentRisk: null, nextCheckAt: null },
      }))
      await findTool("care_manage").handler({
        action: "resolve_incident", id: "c-docker", source: "guard", incidentKey: "docker", expectedUpdatedAt: "v2",
        currentRisk: "another incident remains", nextCheckAt: "2026-09-01T08:15:00.000Z",
      })
      expect(mockResolveCareIncident).toHaveBeenLastCalledWith("/mock/agent-root", "c-docker", expect.objectContaining({
        display: { currentRisk: "another incident remains", nextCheckAt: "2026-09-01T08:15:00.000Z" },
      }))
      await findTool("care_manage").handler({
        action: "resolve_incident", id: "c-books", source: "guard", incidentKey: "books", expectedUpdatedAt: "v3", label: "Books service",
      })
      expect(mockResolveCareIncident).toHaveBeenLastCalledWith("/mock/agent-root", "c-books", expect.objectContaining({ display: { label: "Books service" } }))
    })

    it("preserves omitted metadata during a routine incident refresh", async () => {
      mockUpsertCareForIncident.mockReturnValue({ id: "c-books", label: "Books service", status: "watching" })
      await findTool("care_manage").handler({
        action: "upsert_incident", id: "c-books", source: "sanctuary-health", incidentKey: "container:books",
        classifiedRevision: "rev-2", currentRisk: "Container is restarting", nextCheckAt: "2026-09-01T08:15:00.000Z", expectedUpdatedAt: "v1",
      })
      expect(mockUpsertCareForIncident).toHaveBeenCalledWith("/mock/agent-root", {
        id: "c-books", currentRisk: "Container is restarting", nextCheckAt: "2026-09-01T08:15:00.000Z",
        relatedFriendIds: [], relatedAgentIds: [], relatedObligationIds: [], relatedEpisodeIds: [],
        incident: { source: "sanctuary-health", incidentKey: "container:books", classifiedRevision: "rev-2" }, expectedUpdatedAt: "v1",
      })
    })

    it("atomically upserts one Care for an incident identity", async () => {
      mockUpsertCareForIncident.mockReturnValue({ id: "c-existing", incidentBindings: [{ source: "sanctuary-health", incidentKey: "container:books" }] })
      const tool = findTool("care_manage")
      const result = await tool.handler({
        action: "upsert_incident",
        label: "Books service",
        why: "Keep the family library available",
        source: "sanctuary-health",
        incidentKey: "container:books",
        classifiedRevision: "rev-2",
      })
      expect(mockUpsertCareForIncident).toHaveBeenCalledWith("/mock/agent-root", expect.objectContaining({
        label: "Books service",
        incident: expect.objectContaining({ source: "sanctuary-health", incidentKey: "container:books", classifiedRevision: "rev-2" }),
      }))
      expect(result).toContain("c-existing")
    })

    it("forwards exact Care identity and status during incident refresh", async () => {
      mockUpsertCareForIncident.mockReturnValue({ id: "c-docker", status: "watching" })
      await findTool("care_manage").handler({
        action: "upsert_incident", id: "c-docker", label: "Docker image disk utilization", why: "Verified from current Unraid notifications.",
        kind: "system", status: "watching", salience: "critical", stewardship: "mine", source: "guard", incidentKey: "docker", classifiedRevision: "b".repeat(64), expectedUpdatedAt: "v1",
      })
      expect(mockUpsertCareForIncident).toHaveBeenCalledWith("/mock/agent-root", expect.objectContaining({ id: "c-docker", status: "watching", salience: "critical", steward: "mine", expectedUpdatedAt: "v1" }))
    })

    it("requires CAS fences for existing Care incident mutations", () => {
      const tool = findTool("care_manage")
      expect(() => tool.handler({ action: "bind_incident", id: "c-1" })).toThrow(/requires expectedUpdatedAt/u)
      expect(() => tool.handler({ action: "resolve_incident", id: "c-1" })).toThrow(/requires expectedUpdatedAt/u)
    })

    it("uses incident-upsert defaults and preserves an optional correlation key", async () => {
      mockUpsertCareForIncident.mockReturnValue({ id: "c-default" })
      const tool = findTool("care_manage")
      await tool.handler({ action: "upsert_incident", source: "guard", incidentKey: "usenet", classifiedRevision: "rev-1", correlationKey: "downloads" })
      expect(mockUpsertCareForIncident).toHaveBeenCalledWith("/mock/agent-root", expect.objectContaining({
        label: "untitled",
        why: "",
        kind: "system",
        salience: "medium",
        steward: "mine",
        incident: expect.objectContaining({ correlationKey: "downloads" }),
      }))
    })
  })

  describe("external_event_disposition", () => {
    const batchMember = (index: number) => ({
      schemaVersion: 1 as const,
      recordPath: `/events/ouroboros/sanctuary-health/service-${index}.json`,
      agent: "ouroboros",
      source: "sanctuary-health",
      eventId: `service-${index}`,
      generation: index + 1,
      observationRevision: `rev-${index}`,
      claimOwner: `lease-${index}`,
    })

    const batchDisposition = (member: ReturnType<typeof batchMember>) => ({
      recordPath: member.recordPath,
      expectedGeneration: member.generation,
      classifiedRevision: member.observationRevision,
      classification: "expected",
      stewardPolicyKind: "none",
      decision: "silent",
      reason: `${member.eventId} is expected.`,
      nextWake: "on_change",
    })

    const batchContext = (members: ReturnType<typeof batchMember>[]) => ({
      signin: async () => undefined,
      currentExternalEvent: { ...members[0]!, relatedEvents: members.slice(1) },
      externalEventAuthority: {
        authorizeDisposition: vi.fn(() => ({ allowed: true, reason: "approved" })),
        recordCommittedDisposition: vi.fn(),
      },
    })

    it("advertises a batch schema that validates through the production argument boundary", () => {
      const member = batchMember(0)
      const tool = findTool("external_event_disposition")

      expect(validateAdvertisedToolArguments(
        JSON.stringify({ batch: [batchDisposition(member)] }),
        tool.tool.function.parameters,
      )).toMatchObject({ ok: true })
    })

    it("dispositions all 32 exact coalesced leases through one bounded invocation", async () => {
      const members = Array.from({ length: 32 }, (_, index) => batchMember(index))
      const records = new Map(members.map((member, index) => [member.recordPath, {
        ...member,
        transition: "opened",
        version: index + 10,
        executionState: "running",
      }]))
      mockReadExternalEventRecord.mockImplementation((recordPath) => records.get(String(recordPath)))
      mockCommitExternalEventDisposition.mockImplementation((recordPath) => ({ recordPath, executionState: "handled" }))
      const context = batchContext(members)

      const result = JSON.parse(await findTool("external_event_disposition").handler({
        batch: members.map(batchDisposition),
      } as any, context as any))

      expect(result.results).toHaveLength(32)
      expect(result.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ recordPath: members[0]!.recordPath, ok: true }),
        expect.objectContaining({ recordPath: members[31]!.recordPath, ok: true }),
      ]))
      expect(mockCommitExternalEventDisposition).toHaveBeenCalledTimes(32)
      expect(context.externalEventAuthority.recordCommittedDisposition).toHaveBeenCalledTimes(32)
    })

    it("prevalidates the whole batch before writing and rejects duplicate, foreign, malformed, and oversized forms", async () => {
      const members = [batchMember(0), batchMember(1)]
      mockReadExternalEventRecord.mockImplementation((recordPath) => {
        const member = members.find((candidate) => candidate.recordPath === recordPath)
        return member ? { ...member, transition: "opened", version: 1, executionState: "running" } : { agent: "other" }
      })
      const context = batchContext(members)
      const tool = findTool("external_event_disposition")
      const valid = members.map(batchDisposition)

      for (const batch of [
        [],
        [null, valid[1]],
        [{}, valid[1]],
        [...valid, valid[0]],
        [...valid, { ...valid[1], recordPath: "/events/other/sanctuary-health/foreign.json" }],
        [...valid, { ...valid[1], classifiedRevision: "" }],
        Array.from({ length: 33 }, (_, index) => batchDisposition(batchMember(index))),
      ]) {
        await expect(Promise.resolve().then(() => tool.handler({ batch } as any, context as any))).rejects.toThrow()
        expect(mockCommitExternalEventDisposition).not.toHaveBeenCalled()
      }

      await expect(Promise.resolve().then(() => tool.handler({ ...valid[0], batch: valid } as any, context as any))).rejects.toThrow(/mutually exclusive/u)
      expect(mockCommitExternalEventDisposition).not.toHaveBeenCalled()
    })

    it("requires an active frame for batch authority and supports a frame with no related leases", async () => {
      const member = batchMember(0)
      mockReadExternalEventRecord.mockReturnValue({ ...member, transition: "opened", version: 1, executionState: "running" })
      mockCommitExternalEventDisposition.mockReturnValue({ recordPath: member.recordPath, executionState: "handled" })
      const tool = findTool("external_event_disposition")

      await expect(Promise.resolve().then(() => tool.handler({ batch: [batchDisposition(member)] } as any, undefined))).rejects.toThrow(/every lease.*active.*frame/u)
      await expect(tool.handler({ batch: [batchDisposition(member)] } as any, {
        ...batchContext([member]),
        currentExternalEvent: member,
      } as any)).resolves.toContain('"ok": true')
    })

    it("rejects a batch that omits any lease from the active coalesced frame before writing", async () => {
      const members = [batchMember(0), batchMember(1), batchMember(2)]
      mockReadExternalEventRecord.mockImplementation((recordPath) => {
        const member = members.find((candidate) => candidate.recordPath === recordPath)!
        return { ...member, transition: "opened", version: member.generation + 10, executionState: "running" }
      })

      await expect(Promise.resolve().then(() => findTool("external_event_disposition").handler({
        batch: members.slice(0, 2).map(batchDisposition),
      } as any, batchContext(members) as any))).rejects.toThrow(/every lease.*active.*frame/u)
      expect(mockCommitExternalEventDisposition).not.toHaveBeenCalled()
    })

    it("returns explicit independent results when one prevalidated member conflicts during commit", async () => {
      const members = [batchMember(0), batchMember(1), batchMember(2)]
      mockReadExternalEventRecord.mockImplementation((recordPath) => {
        const member = members.find((candidate) => candidate.recordPath === recordPath)!
        return { ...member, transition: "opened", version: member.generation + 10, executionState: "running" }
      })
      mockCommitExternalEventDisposition.mockImplementation((recordPath) => {
        if (recordPath === members[1]!.recordPath) throw new Error("External event CAS mismatch")
        if (recordPath === members[2]!.recordPath) throw "string conflict"
        return { recordPath, executionState: "handled" }
      })
      const context = batchContext(members)

      const result = JSON.parse(await findTool("external_event_disposition").handler({ batch: members.map(batchDisposition) } as any, context as any))

      expect(result.results).toEqual([
        expect.objectContaining({ recordPath: members[0]!.recordPath, ok: true }),
        { recordPath: members[1]!.recordPath, ok: false, error: "External event CAS mismatch" },
        { recordPath: members[2]!.recordPath, ok: false, error: "string conflict" },
      ])
      expect(context.externalEventAuthority.recordCommittedDisposition).toHaveBeenCalledTimes(1)
    })

    it("delivers an explicit current-policy report once before committing the disposition", async () => {
      vi.mocked(fs.existsSync).mockImplementation((filePath) => String(filePath).endsWith("steward.json"))
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => String(filePath).endsWith("steward.json")
        ? JSON.stringify({ schemaVersion: 1, version: 4, desiredStates: { "service:books": { value: "on", provenance: "stated", version: 4, source: "ari" } }, routineActionGrants: {}, updatedAt: "2026-08-29T00:00:00.000Z" })
        : "")
      mockReadExternalEventRecord.mockReturnValue({ agent: "ouroboros", source: "sanctuary-health", eventId: "books", transition: "opened", version: 4, generation: 2, observationRevision: "rev-2", executionState: "running", claimOwner: "lease-2" })
      mockCommitExternalEventDisposition.mockReturnValue({ executionState: "handled" })
      const deliverOwnerDecision = vi.fn(async () => undefined)
      const recordCommittedDisposition = vi.fn()

      await findTool("external_event_disposition").handler({
        recordPath: "/events/ouroboros/sanctuary-health/books.json", expectedGeneration: 2, classifiedRevision: "rev-2", classification: "needs_attention",
        stewardPolicyKind: "current", stewardPolicyKey: "service:books", stewardPolicyVersion: 4, decision: "report", reason: "Books is down. I’m checking it now.", nextWake: "on_change",
      }, {
        signin: async () => undefined,
        currentExternalEvent: { schemaVersion: 1, recordPath: "/events/ouroboros/sanctuary-health/books.json", agent: "ouroboros", source: "sanctuary-health", eventId: "books", generation: 2, observationRevision: "rev-2", claimOwner: "lease-2" },
        externalEventAuthority: { authorizeDisposition: () => ({ allowed: true, reason: "current" }), recordCommittedDisposition },
        externalEventEffects: { deliverOwnerDecision },
      } as any)

      expect(deliverOwnerDecision).toHaveBeenCalledWith({ source: "sanctuary-health", eventId: "books", generation: 2, text: "Books is down. I’m checking it now." })
      expect(deliverOwnerDecision.mock.invocationCallOrder[0]).toBeLessThan(mockCommitExternalEventDisposition.mock.invocationCallOrder[0]!)
      expect(mockCommitExternalEventDisposition).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ disposition: expect.objectContaining({ stewardPolicy: { kind: "current", key: "service:books", version: 4 } }) }))
      expect(recordCommittedDisposition).toHaveBeenCalledWith(expect.objectContaining({ recordPath: "/events/ouroboros/sanctuary-health/books.json", generation: 2, claimOwner: "lease-2" }))
      expect(mockCommitExternalEventDisposition.mock.invocationCallOrder[0]).toBeLessThan(recordCommittedDisposition.mock.invocationCallOrder[0]!)
    })

    it("rejects stale current policy and allows no-policy dispositions for fresh observations with no applicable key", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      mockReadExternalEventRecord.mockReturnValue({ agent: "ouroboros", source: "sanctuary-health", eventId: "books", transition: "unchanged", version: 4, generation: 2, observationRevision: "rev-2", executionState: "running", claimOwner: "lease-2" })
      const context = { signin: async () => undefined, currentExternalEvent: { schemaVersion: 1 as const, recordPath: "/events/ouroboros/sanctuary-health/books.json", agent: "ouroboros", source: "sanctuary-health", eventId: "books", generation: 2, observationRevision: "rev-2", claimOwner: "lease-2" }, externalEventAuthority: { authorizeDisposition: () => ({ allowed: true, reason: "test" }) } }
      expect(() => findTool("external_event_disposition").handler({ recordPath: context.currentExternalEvent.recordPath, expectedGeneration: 2, classifiedRevision: "rev-2", classification: "expected", stewardPolicyKind: "current", stewardPolicyKey: "service:books", stewardPolicyVersion: 4, decision: "silent", reason: "Expected.", nextWake: "on_change" }, context)).toThrow(/exact current key\/version/u)
      expect(() => findTool("external_event_disposition").handler({ recordPath: context.currentExternalEvent.recordPath, expectedGeneration: 2, classifiedRevision: "rev-2", classification: "expected", stewardPolicyKind: "none", decision: "silent", reason: "No policy yet.", nextWake: "on_change" }, context)).toThrow(/fresh observation/u)
      mockReadExternalEventRecord.mockReturnValue({ agent: "ouroboros", source: "sanctuary-health", eventId: "books", transition: "opened", version: 4, generation: 2, observationRevision: "rev-2", executionState: "running", claimOwner: "lease-2" })
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ schemaVersion: 1, version: 1, desiredStates: { "service:other": { value: "on", provenance: "stated", version: 1, source: "ari" } }, routineActionGrants: {}, updatedAt: "2026-08-29T00:00:00.000Z" }))
      await expect(findTool("external_event_disposition").handler({ recordPath: context.currentExternalEvent.recordPath, expectedGeneration: 2, classifiedRevision: "rev-2", classification: "expected", stewardPolicyKind: "none", decision: "silent", reason: "No applicable policy yet.", nextWake: "on_change" }, context)).resolves.toContain("handled")
    })

    it("validates Care incident ownership and the exact pending Await time", async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      mockReadExternalEventRecord.mockReturnValue({ agent: "ouroboros", source: "sanctuary-health", eventId: "books", recordPath: "/events/ouroboros/sanctuary-health/books.json", transition: "opened", version: 4, generation: 2, observationRevision: "rev-2", executionState: "running", claimOwner: "lease-2" })
      mockReadCares.mockReturnValue([{ id: "care-books", incidentBindings: [{ source: "sanctuary-health", incidentKey: "books", classifiedRevision: "rev-2" }] }])
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => String(filePath).endsWith("await-top-up.md") ? "---\nstatus: pending\nwake_at: 2026-08-30T17:00:00.000Z\nfiled_from: external-event\nfiled_from_key: /events/ouroboros/sanctuary-health/books.json\n---\n\nWaiting.\n" : "")
      const context = { signin: async () => undefined, currentExternalEvent: { schemaVersion: 1 as const, recordPath: "/events/ouroboros/sanctuary-health/books.json", agent: "ouroboros", source: "sanctuary-health", eventId: "books", generation: 2, observationRevision: "rev-2", claimOwner: "lease-2" }, externalEventAuthority: { authorizeDisposition: () => ({ allowed: true, reason: "test" }) }, externalEventEffects: { deliverOwnerDecision: vi.fn(async () => undefined) } }
      const base = { recordPath: context.currentExternalEvent.recordPath, expectedGeneration: 2, classifiedRevision: "rev-2", classification: "snoozed", stewardPolicyKind: "none", decision: "silent", reason: "Waiting.", nextWake: "at", wakeAt: "2026-08-30T17:00:00.000Z", awaitId: "await-top-up" }
      await expect(findTool("external_event_disposition").handler({ ...base, careId: "care-books" }, context)).resolves.toContain("handled")
      mockReadCares.mockReturnValue([{ id: "care-books", incidentBindings: [{ source: "other", incidentKey: "books", classifiedRevision: "rev-2" }] }])
      expect(() => findTool("external_event_disposition").handler({ ...base, careId: "care-books" }, context)).toThrow(/Care does not belong/u)
      mockReadCares.mockReturnValue([])
      expect(() => findTool("external_event_disposition").handler({ ...base, wakeAt: "2026-08-30T18:00:00.000Z" }, context)).toThrow(/exact wake time/u)
    })

    it("prevents a second event from binding an Await owned by the first event", async () => {
      const tool = findTool("external_event_disposition")
      const awaitText = "---\nstatus: pending\nwake_at: 2026-08-30T17:00:00.000Z\nfiled_from: external-event\nfiled_for_friend_id: owner\nfiled_from_key: /events/ouroboros/health/event-a.json\n---\n"
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => String(filePath).endsWith("shared-wake.md")
        ? awaitText
        : JSON.stringify({ schemaVersion: 1, version: 2, desiredStates: {}, routineActionGrants: {}, updatedAt: "2026-08-29T00:00:00.000Z" }))
      mockCommitExternalEventDisposition.mockReturnValue({ executionState: "handled" })
      const timed = { expectedGeneration: 1, classifiedRevision: "rev-1", classification: "snoozed", stewardPolicyKind: "none", decision: "silent", reason: "Wait.", nextWake: "at", wakeAt: "2026-08-30T17:00:00.000Z", awaitId: "shared-wake" }
      const contextFor = (recordPath: string, eventId: string) => ({
        signin: async () => undefined,
        context: { friend: { id: "owner" } },
        currentExternalEvent: { schemaVersion: 1 as const, recordPath, agent: "ouroboros", source: "health", eventId, generation: 1, observationRevision: "rev-1", claimOwner: `lease-${eventId}` },
        externalEventAuthority: { authorizeDisposition: () => ({ allowed: true, reason: "test" }) },
      })

      const eventB = contextFor("/events/ouroboros/health/event-b.json", "event-b")
      mockReadExternalEventRecord.mockReturnValue({ agent: "ouroboros", source: "health", eventId: "event-b", recordPath: eventB.currentExternalEvent.recordPath, transition: "opened", version: 1, generation: 1, observationRevision: "rev-1", executionState: "running", claimOwner: "lease-event-b" })
      expect(() => tool.handler({ ...timed, recordPath: eventB.currentExternalEvent.recordPath }, eventB as any)).toThrow(/owned by this exact external event/u)
      expect(mockCommitExternalEventDisposition).not.toHaveBeenCalled()

      const eventA = contextFor("/events/ouroboros/health/event-a.json", "event-a")
      mockReadExternalEventRecord.mockReturnValue({ agent: "ouroboros", source: "health", eventId: "event-a", recordPath: eventA.currentExternalEvent.recordPath, transition: "opened", version: 1, generation: 1, observationRevision: "rev-1", executionState: "running", claimOwner: "lease-event-a" })
      expect(() => tool.handler({ ...timed, recordPath: eventA.currentExternalEvent.recordPath }, { ...eventA, context: { friend: { id: "other-owner" } } } as any)).toThrow(/owned by this exact external event/u)
      await expect(tool.handler({ ...timed, recordPath: eventA.currentExternalEvent.recordPath }, eventA as any)).resolves.toContain("handled")
    })
    it("disposes an independently fenced member of a coalesced event turn", async () => {
      const tool = findTool("external_event_disposition")
      const related = { schemaVersion: 1 as const, recordPath: "/events/ouroboros/sanctuary-health/sonarr.json", agent: "ouroboros", source: "sanctuary-health", eventId: "sonarr", generation: 3, observationRevision: "rev-sonarr", claimOwner: "lease-sonarr" }
      mockReadExternalEventRecord.mockReturnValue({ agent: "ouroboros", eventId: "sonarr", version: 8, generation: 3, observationRevision: "rev-sonarr", executionState: "running", claimOwner: "lease-sonarr" })
      mockCommitExternalEventDisposition.mockReturnValue({ executionState: "handled" })
      const authorizeDisposition = vi.fn(() => ({ allowed: true, reason: "approved" }))
      await tool.handler({
        recordPath: related.recordPath, expectedGeneration: 3, classifiedRevision: "rev-sonarr", classification: "expected",
        stewardPolicyKind: "current",
        stewardPolicyKey: "service:sonarr", stewardPolicyVersion: 2, decision: "silent", reason: "Expected off.", nextWake: "on_change",
      }, {
        signin: async () => undefined,
        currentExternalEvent: { schemaVersion: 1, recordPath: "/events/ouroboros/sanctuary-health/books.json", agent: "ouroboros", source: "sanctuary-health", eventId: "books", generation: 2, observationRevision: "rev-books", claimOwner: "lease-books", relatedEvents: [related] },
        externalEventAuthority: { authorizeDisposition },
      } as any)
      expect(authorizeDisposition).toHaveBeenCalledWith(expect.objectContaining({ event: related, stewardPolicy: { kind: "current", key: "service:sonarr", version: 2 } }))
      expect(mockCommitExternalEventDisposition).toHaveBeenCalledWith(related.recordPath, expect.objectContaining({ owner: "lease-sonarr", expectedGeneration: 3 }))
    })
    it("claims and commits the current event generation with the Butler's typed reason", async () => {
      mockReadExternalEventRecord.mockReturnValue({ agent: "ouroboros", eventId: "books", version: 4, generation: 2, observationRevision: "rev-2", executionState: "running", claimOwner: "lease-2" })
      mockCommitExternalEventDisposition.mockReturnValue({ executionState: "handled", disposition: { reason: "Expected while the library is sleeping." } })
      const tool = findTool("external_event_disposition")
      const result = await tool.handler({
        recordPath: "/events/ouroboros/sanctuary-health/books.json",
        expectedGeneration: "2",
        classifiedRevision: "rev-2",
        classification: "expected",
        stewardPolicyKind: "current",
        stewardPolicyKey: "service:books",
        stewardPolicyVersion: 2,
        decision: "silent",
        reason: "Expected while the library is sleeping.",
        nextWake: "on_change",
      }, {
        signin: async () => undefined,
        currentExternalEvent: { schemaVersion: 1, recordPath: "/events/ouroboros/sanctuary-health/books.json", agent: "ouroboros", source: "sanctuary-health", eventId: "books", generation: 2, observationRevision: "rev-2", claimOwner: "lease-2" },
        externalEventAuthority: { authorizeDisposition: () => ({ allowed: true, reason: "test" }) },
      })

      expect(mockCommitExternalEventDisposition).toHaveBeenCalledWith("/events/ouroboros/sanctuary-health/books.json", expect.objectContaining({
        owner: "lease-2",
        expectedVersion: 4,
        expectedGeneration: 2,
        disposition: expect.objectContaining({ classifiedRevision: "rev-2", reason: "Expected while the library is sleeping.", nextWake: { kind: "on_change" } }),
      }))
      expect(result).toContain("handled")
    })

    it("resumes its generation-scoped claim after a turn crash without waiting for the lease", async () => {
      mockReadExternalEventRecord.mockReturnValue({
        agent: "ouroboros",
        version: 7,
        generation: 3,
        observationRevision: "rev-3",
        executionState: "running",
        claimOwner: "agent-disposition:ouroboros:3",
      })
      mockCommitExternalEventDisposition.mockReturnValue({ executionState: "handled" })

      const tool = findTool("external_event_disposition")
      await tool.handler({
        recordPath: "/events/ouroboros/sanctuary-health/books.json",
        expectedGeneration: "3",
        classifiedRevision: "rev-3",
        classification: "expected",
        stewardPolicyKind: "current",
        stewardPolicyKey: "service:books",
        stewardPolicyVersion: 2,
        decision: "silent",
        reason: "Expected while the library is sleeping.",
        nextWake: "on_change",
      }, {
        signin: async () => undefined,
        currentExternalEvent: { schemaVersion: 1, recordPath: "/events/ouroboros/sanctuary-health/books.json", agent: "ouroboros", source: "sanctuary-health", eventId: "books", generation: 3, observationRevision: "rev-3", claimOwner: "agent-disposition:ouroboros:3" },
        externalEventAuthority: { authorizeDisposition: () => ({ allowed: true, reason: "test" }) },
      })

      expect(mockClaimExternalEvent).not.toHaveBeenCalled()
      expect(mockCommitExternalEventDisposition).toHaveBeenCalledWith(
        "/events/ouroboros/sanctuary-health/books.json",
        expect.objectContaining({
          owner: "agent-disposition:ouroboros:3",
          expectedVersion: 7,
          expectedGeneration: 3,
        }),
      )
    })

    it("rejects records outside the current agent's canonical event root", async () => {
      const tool = findTool("external_event_disposition")
      expect(() => tool.handler({ recordPath: "/tmp/other.json" })).toThrow(/current agent/u)
      expect(mockClaimExternalEvent).not.toHaveBeenCalled()
    })

    it("rejects a missing receipt path and a receipt owned by another agent", () => {
      const tool = findTool("external_event_disposition")
      expect(() => tool.handler({})).toThrow(/current agent/u)
      mockReadExternalEventRecord.mockReturnValue({ agent: "other" })
      expect(() => tool.handler({ recordPath: "/events/ouroboros/sanctuary-health/books.json" })).toThrow(/current agent/u)
    })

    it("fails closed without the exact turn lease", async () => {
      mockReadExternalEventRecord.mockReturnValue({ agent: "ouroboros", eventId: "books", version: 4, generation: 2, observationRevision: "rev-2", executionState: "running", claimOwner: "lease-2" })
      const tool = findTool("external_event_disposition")
      expect(() => tool.handler({
        recordPath: "/events/ouroboros/sanctuary-health/books.json",
        expectedGeneration: 2,
        classifiedRevision: "rev-2",
      }, { signin: async () => undefined })).toThrow(/exact turn lease/u)
      expect(mockCommitExternalEventDisposition).not.toHaveBeenCalled()
    })

    it("fails closed when the disposition omits its classified revision", () => {
      mockReadExternalEventRecord.mockReturnValue({ agent: "ouroboros", eventId: "books", version: 4, generation: 2, observationRevision: "rev-2", executionState: "running", claimOwner: "lease-2" })
      const tool = findTool("external_event_disposition")
      expect(() => tool.handler({ recordPath: "/events/ouroboros/sanctuary-health/books.json", expectedGeneration: 2 }, {
        signin: async () => undefined,
        currentExternalEvent: { schemaVersion: 1, recordPath: "/events/ouroboros/sanctuary-health/books.json", agent: "ouroboros", source: "sanctuary-health", eventId: "books", generation: 2, observationRevision: "rev-2", claimOwner: "lease-2" },
      })).toThrow(/exact turn lease/u)
    })

    it("fails closed when Unit 2 authority is unavailable", async () => {
      mockReadExternalEventRecord.mockReturnValue({ agent: "ouroboros", eventId: "books", version: 4, generation: 2, observationRevision: "rev-2", executionState: "running", claimOwner: "lease-2" })
      const tool = findTool("external_event_disposition")
      expect(() => tool.handler({
        recordPath: "/events/ouroboros/sanctuary-health/books.json",
        expectedGeneration: 2,
        classifiedRevision: "rev-2",
        classification: "expected",
        stewardPolicyKind: "current",
        stewardPolicyKey: "service:books",
        stewardPolicyVersion: 2,
        decision: "silent",
        reason: "Expected while the library is sleeping.",
        nextWake: "on_change",
      }, {
        signin: async () => undefined,
        currentExternalEvent: { schemaVersion: 1, recordPath: "/events/ouroboros/sanctuary-health/books.json", agent: "ouroboros", source: "sanctuary-health", eventId: "books", generation: 2, observationRevision: "rev-2", claimOwner: "lease-2" },
      })).toThrow(/authority unavailable/u)
      expect(mockCommitExternalEventDisposition).not.toHaveBeenCalled()
    })

    it("rejects an invalid disposition before consulting authority", async () => {
      mockReadExternalEventRecord.mockReturnValue({ agent: "ouroboros", eventId: "books", version: 4, generation: 2, observationRevision: "rev-2", executionState: "running", claimOwner: "lease-2" })
      const authorizeDisposition = vi.fn()
      const tool = findTool("external_event_disposition")
      expect(() => tool.handler({
        recordPath: "/events/ouroboros/sanctuary-health/books.json",
        expectedGeneration: 2,
        classifiedRevision: "rev-2",
        classification: "expected",
        stewardPolicyKind: "current",
        stewardPolicyKey: "service:books",
        stewardPolicyVersion: 0,
        decision: "silent",
        reason: "",
        nextWake: "on_change",
      }, {
        signin: async () => undefined,
        currentExternalEvent: { schemaVersion: 1, recordPath: "/events/ouroboros/sanctuary-health/books.json", agent: "ouroboros", source: "sanctuary-health", eventId: "books", generation: 2, observationRevision: "rev-2", claimOwner: "lease-2" },
        externalEventAuthority: { authorizeDisposition },
      })).toThrow(/disposition is invalid/u)
      expect(authorizeDisposition).not.toHaveBeenCalled()
    })

    it.each([
      ["missing reason", { reason: "" }],
      ["missing typed policy kind", { stewardPolicyKind: undefined }],
      ["fractional policy version", { stewardPolicyVersion: 1.5 }],
      ["non-positive policy version", { stewardPolicyVersion: 0 }],
      ["unknown classification", { classification: "unknown" }],
      ["unknown decision", { decision: "unknown" }],
      ["unknown wake", { nextWake: "unknown" }],
    ])("rejects %s", (_label, override) => {
      mockReadExternalEventRecord.mockReturnValue({ agent: "ouroboros", eventId: "books", version: 4, generation: 2, observationRevision: "rev-2", executionState: "running", claimOwner: "lease-2" })
      const tool = findTool("external_event_disposition")
      expect(() => tool.handler({
        recordPath: "/events/ouroboros/sanctuary-health/books.json",
        expectedGeneration: 2,
        classifiedRevision: "rev-2",
        classification: "expected",
        stewardPolicyKind: "current",
        stewardPolicyKey: "service:books",
        stewardPolicyVersion: 2,
        decision: "silent",
        reason: "Expected.",
        nextWake: "on_change",
        ...override,
      }, {
        signin: async () => undefined,
        currentExternalEvent: { schemaVersion: 1, recordPath: "/events/ouroboros/sanctuary-health/books.json", agent: "ouroboros", source: "sanctuary-health", eventId: "books", generation: 2, observationRevision: "rev-2", claimOwner: "lease-2" },
        externalEventAuthority: { authorizeDisposition: () => ({ allowed: true, reason: "test" }) },
      })).toThrow(/disposition is invalid/u)
    })

    it("passes an await-backed time disposition and optional Care references to authority", async () => {
      mockReadExternalEventRecord.mockReturnValue({ agent: "ouroboros", source: "sanctuary-health", eventId: "books", recordPath: "/events/ouroboros/sanctuary-health/books.json", version: 4, generation: 2, observationRevision: "rev-2", executionState: "running", claimOwner: "lease-2" })
      mockCommitExternalEventDisposition.mockReturnValue({ executionState: "handled" })
      mockReadCares.mockReturnValue([{ id: "care-downloads", incidentBindings: [{ source: "sanctuary-health", incidentKey: "books", classifiedRevision: "rev-2" }] }])
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => String(filePath).endsWith("steward.json")
        ? JSON.stringify({ schemaVersion: 1, version: 2, desiredStates: { "service:books": { value: "on", provenance: "stated", version: 2, source: "ari" } }, routineActionGrants: {}, updatedAt: "2026-08-29T00:00:00.000Z" })
        : String(filePath).endsWith("await-top-up.md") ? "---\nstatus: pending\nwake_at: 2026-08-30T17:00:00.000Z\nfiled_from: external-event\nfiled_from_key: /events/ouroboros/sanctuary-health/books.json\n---\n\nWaiting.\n" : "")
      const authorizeDisposition = vi.fn(() => ({ allowed: true, reason: "approved" }))
      const deliverOwnerDecision = vi.fn(async () => undefined)
      const tool = findTool("external_event_disposition")
      await tool.handler({
        recordPath: "/events/ouroboros/sanctuary-health/books.json",
        expectedGeneration: 2,
        classifiedRevision: "rev-2",
        classification: "snoozed",
        stewardPolicyKind: "current",
        stewardPolicyKey: "service:books",
        stewardPolicyVersion: 2,
        decision: "ask",
        reason: "Waiting for the top-up.",
        nextWake: "at",
        wakeAt: "2026-08-30T17:00:00.000Z",
        awaitId: "await-top-up",
        careId: "care-downloads",
      }, {
        signin: async () => undefined,
        currentExternalEvent: { schemaVersion: 1, recordPath: "/events/ouroboros/sanctuary-health/books.json", agent: "ouroboros", source: "sanctuary-health", eventId: "books", generation: 2, observationRevision: "rev-2", claimOwner: "lease-2" },
        externalEventAuthority: { authorizeDisposition }, externalEventEffects: { deliverOwnerDecision },
      })
      expect(authorizeDisposition).toHaveBeenCalledWith(expect.objectContaining({ wakeAt: "2026-08-30T17:00:00.000Z", awaitId: "await-top-up", careId: "care-downloads", stewardPolicy: { kind: "current", key: "service:books", version: 2 } }))
      expect(deliverOwnerDecision).toHaveBeenCalledOnce()
      expect(mockCommitExternalEventDisposition).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ disposition: expect.objectContaining({ awaitId: "await-top-up", careId: "care-downloads" }) }))
    })

    it("rejects a missing reason and an unbound timed wake before authority", () => {
      mockReadExternalEventRecord.mockReturnValue({ agent: "ouroboros", eventId: "books", version: 4, generation: 2, observationRevision: "rev-2", executionState: "running", claimOwner: "lease-2" })
      const tool = findTool("external_event_disposition")
      const context = {
        signin: async () => undefined,
        currentExternalEvent: { schemaVersion: 1 as const, recordPath: "/events/ouroboros/sanctuary-health/books.json", agent: "ouroboros", source: "sanctuary-health", eventId: "books", generation: 2, observationRevision: "rev-2", claimOwner: "lease-2" },
        externalEventAuthority: { authorizeDisposition: vi.fn(() => ({ allowed: false, reason: "missing await" })) },
      }
      expect(() => tool.handler({ recordPath: context.currentExternalEvent.recordPath, expectedGeneration: 2, classifiedRevision: "rev-2", classification: "expected", stewardPolicyKind: "current", stewardPolicyKey: "test", stewardPolicyVersion: 2, decision: "silent", nextWake: "on_change" }, context)).toThrow(/invalid/u)
      expect(() => tool.handler({ recordPath: context.currentExternalEvent.recordPath, expectedGeneration: 2, classifiedRevision: "rev-2", classification: "expected", stewardPolicyKind: "current", stewardPolicyKey: "test", stewardPolicyVersion: 2, decision: "silent", reason: "wait", nextWake: "at" }, context)).toThrow(/current pending Await/u)
      expect(context.externalEventAuthority.authorizeDisposition).not.toHaveBeenCalled()
    })

    it("covers exact policy, adoption, Await safety, and owner-delivery rejection boundaries", async () => {
      const tool = findTool("external_event_disposition")
      const currentExternalEvent = { schemaVersion: 1 as const, recordPath: "/events/ouroboros/sanctuary-health/books.json", agent: "ouroboros", source: "sanctuary-health", eventId: "books", generation: 2, observationRevision: "rev-2", claimOwner: "lease-2" }
      const authority = { authorizeDisposition: vi.fn(() => ({ allowed: true, reason: "ok" })) }
      const base = { recordPath: currentExternalEvent.recordPath, expectedGeneration: 2, classifiedRevision: "rev-2", classification: "expected", stewardPolicyKind: "current", stewardPolicyKey: "service:books", stewardPolicyVersion: 2, decision: "silent", reason: "Expected.", nextWake: "on_change" }
      mockReadExternalEventRecord.mockReturnValue({ agent: "ouroboros", source: "sanctuary-health", eventId: "books", recordPath: currentExternalEvent.recordPath, transition: "opened", version: 4, generation: 2, observationRevision: "rev-2", executionState: "running", claimOwner: "lease-2" })
      expect(() => tool.handler({ ...base, stewardPolicyKey: "" }, { signin: async () => undefined, currentExternalEvent, externalEventAuthority: authority })).toThrow("invalid")
      expect(() => tool.handler({ ...base, stewardPolicyKey: undefined }, { signin: async () => undefined, currentExternalEvent, externalEventAuthority: authority })).toThrow("invalid")
      expect(() => tool.handler({ ...base, classification: "adopted" }, { signin: async () => undefined, currentExternalEvent, externalEventAuthority: authority })).toThrow("requires a Care")
      expect(() => tool.handler({ ...base, classification: "adopted", careId: 42 }, { signin: async () => undefined, currentExternalEvent, externalEventAuthority: authority })).toThrow("requires a Care")
      mockReadCares.mockReturnValue([{ id: "adopted-care", incidentBindings: [{ source: "sanctuary-health", incidentKey: "books", classifiedRevision: "rev-2" }] }])
      expect(() => tool.handler({ ...base, classification: "adopted", careId: "adopted-care" }, { signin: async () => undefined, currentExternalEvent, externalEventAuthority: authority })).not.toThrow()
      expect(() => tool.handler({ ...base, careId: "" }, { signin: async () => undefined, currentExternalEvent, externalEventAuthority: authority })).not.toThrow()
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => String(filePath).endsWith("steward.json")
        ? JSON.stringify({ schemaVersion: 1, version: 2, desiredStates: {}, routineActionGrants: { "service:books": { action: "restart", targets: ["books"], exclusions: [], maxCount: 1, windowMs: 1, verificationRequired: true, provenance: "stated", version: 2 } }, updatedAt: "2026-08-29T00:00:00.000Z" })
        : String(filePath).endsWith("resolved.md") ? "---\nstatus: resolved\nwake_at: 2026-08-30T17:00:00.000Z\nfiled_from: external-event\nfiled_from_key: /events/ouroboros/sanctuary-health/books.json\n---\n\nDone.\n" : "")
      expect(() => tool.handler(base, { signin: async () => undefined, currentExternalEvent, externalEventAuthority: authority })).not.toThrow()
      expect(() => tool.handler({ ...base, nextWake: "at", wakeAt: "2026-08-30T17:00:00.000Z", awaitId: "resolved" }, { signin: async () => undefined, currentExternalEvent, externalEventAuthority: authority })).toThrow("does not match the exact wake time")
      vi.mocked(fs.lstatSync).mockReturnValueOnce({ isFile: () => false, isSymbolicLink: () => true } as any)
      expect(() => tool.handler({ ...base, nextWake: "at", wakeAt: "2026-08-30T17:00:00.000Z", awaitId: "unsafe" }, { signin: async () => undefined, currentExternalEvent, externalEventAuthority: authority })).toThrow("current pending Await")
      await expect(tool.handler({ ...base, decision: "report", reason: "x".repeat(1_201) }, { signin: async () => undefined, currentExternalEvent, externalEventAuthority: authority } as any)).rejects.toThrow("phone-sized")
      await expect(tool.handler({ ...base, decision: "report" }, { signin: async () => undefined, currentExternalEvent, externalEventAuthority: authority } as any)).rejects.toThrow("delivery is unavailable")
    })

    it("routes action and verification references through the injected authority", async () => {
      mockReadExternalEventRecord.mockReturnValue({ agent: "ouroboros", eventId: "books", version: 4, generation: 2, observationRevision: "rev-2", executionState: "running", claimOwner: "lease-2" })
      mockCommitExternalEventDisposition.mockReturnValue({ executionState: "handled" })
      const authorizeDisposition = vi.fn(() => ({ allowed: true, reason: "approved by Unit 2" }))
      const tool = findTool("external_event_disposition")
      await tool.handler({
        recordPath: "/events/ouroboros/sanctuary-health/books.json",
        expectedGeneration: 2,
        classifiedRevision: "rev-2",
        classification: "needs_attention",
        stewardPolicyKind: "current",
        stewardPolicyKey: "service:books",
        stewardPolicyVersion: 2,
        decision: "act",
        reason: "Repaired and verified.",
        nextWake: "on_change",
        actionRefs: ["action:restart:books"],
        verificationRefs: ["check:books:healthy"],
      }, {
        signin: async () => undefined,
        currentExternalEvent: { schemaVersion: 1, recordPath: "/events/ouroboros/sanctuary-health/books.json", agent: "ouroboros", source: "sanctuary-health", eventId: "books", generation: 2, observationRevision: "rev-2", claimOwner: "lease-2" },
        externalEventAuthority: { authorizeDisposition },
      })
      expect(authorizeDisposition).toHaveBeenCalledWith(expect.objectContaining({
        actionRefs: ["action:restart:books"],
        verificationRefs: ["check:books:healthy"],
      }))
    })
  })

  describe("query_relationships", () => {
    it("tool exists in baseToolDefinitions", () => {
      const tool = findTool("query_relationships")
      expect(tool).toBeDefined()
    })

    it("returns all agent friends when no agentName", async () => {
      const mockListAll = vi.fn().mockResolvedValue([
        { id: "uuid-1", name: "Slugger", kind: "agent", agentMeta: { bundleName: "slugger.ouro", familiarity: 3, sharedMissions: [], outcomes: [] } },
        { id: "uuid-2", name: "Jordan", kind: "human" },
      ])
      const ctx = { friendStore: { listAll: mockListAll } } as any

      const tool = findTool("query_relationships")
      const result = await tool.handler({}, ctx)
      expect(mockListAll).toHaveBeenCalled()
      expect(result).toContain("Slugger")
      expect(result).not.toContain("Jordan")
    })

    it("filters by agentName (case-insensitive)", async () => {
      const mockListAll = vi.fn().mockResolvedValue([
        { id: "uuid-1", name: "Slugger", kind: "agent", agentMeta: { bundleName: "slugger.ouro", familiarity: 3, sharedMissions: [], outcomes: [] } },
        { id: "uuid-2", name: "Copilot", kind: "agent", agentMeta: { bundleName: "copilot.ouro", familiarity: 1, sharedMissions: [], outcomes: [] } },
      ])
      const ctx = { friendStore: { listAll: mockListAll } } as any

      const tool = findTool("query_relationships")
      const result = await tool.handler({ agentName: "SLUGGER" }, ctx)
      expect(result).toContain("Slugger")
      expect(result).not.toContain("Copilot")
    })

    it("returns empty when no agent friends exist", async () => {
      const mockListAll = vi.fn().mockResolvedValue([
        { id: "uuid-1", name: "Jordan", kind: "human" },
      ])
      const ctx = { friendStore: { listAll: mockListAll } } as any

      const tool = findTool("query_relationships")
      const result = await tool.handler({}, ctx)
      expect(result).toBe("[]")
    })

    it("returns empty array when friendStore is not available", async () => {
      const tool = findTool("query_relationships")
      const result = await tool.handler({})
      expect(result).toBe("[]")
    })
  })

  describe("intention_capture", () => {
    it("tool exists in baseToolDefinitions", () => {
      const tool = findTool("intention_capture")
      expect(tool).toBeDefined()
    })

    it("captures a lightweight intention", async () => {
      const mockIntention = { id: "int-1", content: "check on deploy", status: "open" }
      mockCaptureIntention.mockReturnValue(mockIntention)

      const tool = findTool("intention_capture")
      const result = await tool.handler({ content: "check on deploy" })
      expect(mockCaptureIntention).toHaveBeenCalledWith(
        "/mock/agent-root",
        expect.objectContaining({ content: "check on deploy", source: "tool" }),
      )
      expect(result).toContain("int-1")
    })
  })

  describe("query_episodes edge cases", () => {
    it("returns empty array when no episodes exist", async () => {
      mockReadRecentEpisodes.mockReturnValue([])
      const tool = findTool("query_episodes")
      const result = await tool.handler({})
      expect(result).toBe("[]")
    })

    it("passes kind filter when provided", async () => {
      mockReadRecentEpisodes.mockReturnValue([])
      const tool = findTool("query_episodes")
      await tool.handler({ kind: "turning_point" })
      expect(mockReadRecentEpisodes).toHaveBeenCalledWith(
        "/mock/agent-root",
        expect.objectContaining({ kinds: ["turning_point"] }),
      )
    })

    it("passes limit when provided", async () => {
      mockReadRecentEpisodes.mockReturnValue([])
      const tool = findTool("query_episodes")
      await tool.handler({ limit: "5" })
      expect(mockReadRecentEpisodes).toHaveBeenCalledWith(
        "/mock/agent-root",
        expect.objectContaining({ limit: 5 }),
      )
    })
  })

  describe("query_presence edge cases", () => {
    it("handles null self presence", async () => {
      mockReadPresence.mockReturnValue(null)
      mockReadPeerPresence.mockReturnValue([])
      const tool = findTool("query_presence")
      const result = await tool.handler({})
      expect(result).toContain("null")
    })
  })

  describe("care_manage edge cases", () => {
    it("uses defaults when optional fields omitted on create", async () => {
      const mockCare = { id: "c-default", label: "untitled", status: "active" }
      mockCreateCare.mockReturnValue(mockCare)
      const tool = findTool("care_manage")
      await tool.handler({ action: "create" })
      expect(mockCreateCare).toHaveBeenCalledWith(
        "/mock/agent-root",
        expect.objectContaining({ label: "untitled", kind: "project", salience: "medium" }),
      )
    })

    it("passes why and salience fields when updating a care", async () => {
      const mockCare = { id: "c-1", label: "updated", status: "active" }
      mockUpdateCare.mockReturnValue(mockCare)

      const tool = findTool("care_manage")
      await tool.handler({ action: "update", id: "c-1", label: "renamed", why: "reprioritized", salience: "high" })
      expect(mockUpdateCare).toHaveBeenCalledWith(
        "/mock/agent-root",
        "c-1",
        expect.objectContaining({ label: "renamed", why: "reprioritized", salience: "high" }),
      )
    })

    it("handles unknown action gracefully (no create/update/resolve match)", async () => {
      const tool = findTool("care_manage")
      const result = await tool.handler({ action: "unknown-action" })
      // JSON.stringify(undefined) returns undefined (not a string)
      expect(result).toBeUndefined()
    })

    it("updates a care with only why (no label or salience)", async () => {
      const mockCare = { id: "c-2", label: "unchanged", status: "active" }
      mockUpdateCare.mockReturnValue(mockCare)

      const tool = findTool("care_manage")
      await tool.handler({ action: "update", id: "c-2", why: "new reason" })
      const updates = mockUpdateCare.mock.calls[mockUpdateCare.mock.calls.length - 1][2]
      expect(updates).toEqual({ why: "new reason" })
      expect(updates).not.toHaveProperty("label")
      expect(updates).not.toHaveProperty("salience")
    })

    it("clears optional risk and next-check fields explicitly", async () => {
      mockUpdateCare.mockReturnValue({ id: "c-clear" })
      await findTool("care_manage").handler({ action: "update", id: "c-clear", currentRisk: "", nextCheckAt: "" })
      expect(mockUpdateCare).toHaveBeenCalledWith("/mock/agent-root", "c-clear", { currentRisk: null, nextCheckAt: null })
    })

    it("passes explicit optional Care fields on create and incident upsert", async () => {
      mockCreateCare.mockReturnValue({ id: "c-explicit" })
      await findTool("care_manage").handler({ action: "create", currentRisk: "risk", nextCheckAt: "soon" })
      expect(mockCreateCare).toHaveBeenCalledWith("/mock/agent-root", expect.objectContaining({ currentRisk: "risk", nextCheckAt: "soon" }))
      mockUpsertCareForIncident.mockReturnValue({ id: "c-upsert" })
      await findTool("care_manage").handler({ action: "upsert_incident", source: "guard", incidentKey: "books", classifiedRevision: "rev", currentRisk: "risk", nextCheckAt: "soon", expectedUpdatedAt: "version", correlationKey: "media" })
      expect(mockUpsertCareForIncident).toHaveBeenCalledWith("/mock/agent-root", expect.objectContaining({ currentRisk: "risk", nextCheckAt: "soon", expectedUpdatedAt: "version", incident: expect.objectContaining({ correlationKey: "media" }) }))
    })
  })

  describe("query_episodes edge cases", () => {
    it("passes since filter when provided", async () => {
      mockReadRecentEpisodes.mockReturnValue([])
      const tool = findTool("query_episodes")
      await tool.handler({ since: "2026-04-01T00:00:00Z" })
      expect(mockReadRecentEpisodes).toHaveBeenCalledWith(
        "/mock/agent-root",
        expect.objectContaining({ since: "2026-04-01T00:00:00Z" }),
      )
    })
  })

  describe("intention_capture edge cases", () => {
    it("passes nudgeAfter when provided", async () => {
      const mockIntention = { id: "int-2", content: "follow up", status: "open" }
      mockCaptureIntention.mockReturnValue(mockIntention)

      const tool = findTool("intention_capture")
      await tool.handler({ content: "follow up", nudgeAfter: "2026-04-10T00:00:00Z" })
      expect(mockCaptureIntention).toHaveBeenCalledWith(
        "/mock/agent-root",
        expect.objectContaining({ content: "follow up", nudgeAfter: "2026-04-10T00:00:00Z" }),
      )
    })
  })

  describe("intention_manage", () => {
    it("tool exists in baseToolDefinitions", () => {
      const tool = findTool("intention_manage")
      expect(tool).toBeDefined()
    })

    it("resolves an intention when action=resolve", async () => {
      const mockIntention = { id: "int-1", content: "done", status: "done" }
      mockResolveIntention.mockReturnValue(mockIntention)

      const tool = findTool("intention_manage")
      const result = await tool.handler({ action: "resolve", id: "int-1" })
      expect(mockResolveIntention).toHaveBeenCalledWith("/mock/agent-root", "int-1")
    })

    it("dismisses an intention when action=dismiss", async () => {
      const mockIntention = { id: "int-1", content: "nevermind", status: "dismissed" }
      mockDismissIntention.mockReturnValue(mockIntention)

      const tool = findTool("intention_manage")
      const result = await tool.handler({ action: "dismiss", id: "int-1" })
      expect(mockDismissIntention).toHaveBeenCalledWith("/mock/agent-root", "int-1")
    })
  })
})
