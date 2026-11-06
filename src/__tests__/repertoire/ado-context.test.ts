import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../repertoire/ado-client", () => ({
  discoverOrganizations: vi.fn(),
  discoverProjects: vi.fn(),
}))

import { discoverOrganizations, discoverProjects } from "../../repertoire/ado-client"

import { resolveAdoContext } from "../../repertoire/ado-context"
import type { ResolvedContext } from "@ouro.bot/friends"

function makeTeamsContext(overrides?: Partial<ResolvedContext>): ResolvedContext {
  return {
    identity: {
      id: "uuid-1",
      displayName: "Jordan",
      externalIds: [{ provider: "aad", externalId: "jordan@contoso.com", tenantId: "t1", linkedAt: "2026-01-01" }],
      tenantMemberships: ["t1"],
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      schemaVersion: 1,
    },
    channel: {
      channel: "teams",
      availableIntegrations: ["ado", "graph"],
      supportsMarkdown: true,
      supportsStreaming: true,
      supportsRichCards: true,
      maxMessageLength: 28000,
    },
    ...overrides,
  }
}

function makeCliContext(): ResolvedContext {
  return {
    identity: {
      id: "uuid-2",
      displayName: "jsmith",
      externalIds: [{ provider: "local", externalId: "jsmith", linkedAt: "2026-01-01" }],
      tenantMemberships: [],
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      schemaVersion: 1,
    },
    channel: {
      channel: "cli",
      availableIntegrations: [],
      supportsMarkdown: false,
      supportsStreaming: true,
      supportsRichCards: false,
      maxMessageLength: Infinity,
    },
  }
}

describe("resolveAdoContext", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("returns org and project when provided by model (no discovery needed)", async () => {
    const result = await resolveAdoContext(
      "test-token",
      makeTeamsContext(),
      { organization: "myorg", project: "myproject" },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.organization).toBe("myorg")
      expect(result.project).toBe("myproject")
    }
    // No discovery calls
    expect(discoverOrganizations).not.toHaveBeenCalled()
    expect(discoverProjects).not.toHaveBeenCalled()
  })

  it("runs discovery cascade when org is omitted -- single org auto-selects", async () => {
    vi.mocked(discoverOrganizations).mockResolvedValue(["contoso"])
    vi.mocked(discoverProjects).mockResolvedValue(["Platform"])

    const result = await resolveAdoContext("test-token", makeTeamsContext())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.organization).toBe("contoso")
      expect(result.project).toBe("Platform")
    }
  })

  it("returns disambiguation when multiple orgs found", async () => {
    vi.mocked(discoverOrganizations).mockResolvedValue(["contoso", "fabrikam"])

    const result = await resolveAdoContext("test-token", makeTeamsContext())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("contoso")
      expect(result.error).toContain("fabrikam")
    }
  })

  it("returns error when no orgs found", async () => {
    vi.mocked(discoverOrganizations).mockResolvedValue([])

    const result = await resolveAdoContext("test-token", makeTeamsContext())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("No ADO organizations")
    }
  })

  it("returns disambiguation when multiple projects found (org auto-selected)", async () => {
    vi.mocked(discoverOrganizations).mockResolvedValue(["contoso"])
    vi.mocked(discoverProjects).mockResolvedValue(["Platform", "Mobile", "Backend"])

    const result = await resolveAdoContext("test-token", makeTeamsContext())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("Platform")
      expect(result.error).toContain("Mobile")
    }
  })

  it("auto-selects single project when only one found", async () => {
    vi.mocked(discoverOrganizations).mockResolvedValue(["contoso"])
    vi.mocked(discoverProjects).mockResolvedValue(["OnlyProject"])

    const result = await resolveAdoContext("test-token", makeTeamsContext())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.organization).toBe("contoso")
      expect(result.project).toBe("OnlyProject")
    }
  })

  it("returns error when no projects found for discovered org", async () => {
    vi.mocked(discoverOrganizations).mockResolvedValue(["contoso"])
    vi.mocked(discoverProjects).mockResolvedValue([])

    const result = await resolveAdoContext("test-token", makeTeamsContext())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("No projects")
    }
  })

  it("runs project discovery when org provided but project omitted", async () => {
    vi.mocked(discoverProjects).mockResolvedValue(["Platform"])

    const result = await resolveAdoContext(
      "test-token",
      makeTeamsContext(),
      { organization: "myorg" },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.organization).toBe("myorg")
      expect(result.project).toBe("Platform")
    }
    expect(discoverOrganizations).not.toHaveBeenCalled()
    expect(discoverProjects).toHaveBeenCalledWith("test-token", "myorg")
  })

  it("returns error for CLI context (no ADO integration)", async () => {
    const result = await resolveAdoContext("test-token", makeCliContext())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("not available")
    }
  })

  it("handles discovery error gracefully (Error object)", async () => {
    vi.mocked(discoverOrganizations).mockRejectedValue(new Error("network error"))

    const result = await resolveAdoContext("test-token", makeTeamsContext())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("network error")
    }
  })

  it("handles discovery error gracefully (non-Error thrown)", async () => {
    vi.mocked(discoverOrganizations).mockRejectedValue("string error")

    const result = await resolveAdoContext("test-token", makeTeamsContext())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("string error")
    }
  })
})
