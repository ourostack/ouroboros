import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

import { queryWorkItems, adoRequest, discoverOrganizations, discoverProjects } from "../../repertoire/ado-client"

describe("queryWorkItems", () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it("returns formatted work items on success", async () => {
    // First call: WIQL query returns work item IDs
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          workItems: [{ id: 123 }, { id: 456 }],
        }),
      })
      // Second call: fetch work item details
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: 123,
              fields: {
                "System.Title": "Fix the bug",
                "System.State": "Active",
                "System.AssignedTo": { displayName: "Jane Doe" },
              },
            },
            {
              id: 456,
              fields: {
                "System.Title": "Add feature",
                "System.State": "New",
                "System.AssignedTo": { displayName: "John Smith" },
              },
            },
          ],
        }),
      })

    const result = await queryWorkItems("test-token", "myorg", "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active'")

    expect(result).toContain("123")
    expect(result).toContain("Fix the bug")
    expect(result).toContain("Active")
    expect(result).toContain("Jane Doe")
    expect(result).toContain("456")
    expect(result).toContain("Add feature")

    // Verify WIQL call
    expect(mockFetch).toHaveBeenCalledWith(
      "https://dev.azure.com/myorg/_apis/wit/wiql?api-version=7.1",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        }),
      }),
    )
  })

  it("returns message when no work items found", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        workItems: [],
      }),
    })

    const result = await queryWorkItems("test-token", "myorg", "SELECT [System.Id] FROM WorkItems")
    expect(result).toContain("No work items found")
  })

  it("handles unassigned work items", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          workItems: [{ id: 789 }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: 789,
              fields: {
                "System.Title": "Unassigned task",
                "System.State": "New",
                "System.AssignedTo": null,
              },
            },
          ],
        }),
      })

    const result = await queryWorkItems("test-token", "myorg", "query")
    expect(result).toContain("789")
    expect(result).toContain("Unassigned task")
    expect(result).toContain("Unassigned")
  })

  it("returns AUTH_REQUIRED on 401 from WIQL query", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    })

    const result = await queryWorkItems("bad-token", "myorg", "query")
    expect(result).toBe("AUTH_REQUIRED:ado")
  })

  it("returns AUTH_REQUIRED on 401 from work item details fetch", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ workItems: [{ id: 1 }] }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      })

    const result = await queryWorkItems("token", "myorg", "query")
    expect(result).toBe("AUTH_REQUIRED:ado")
  })

  it("returns PERMISSION_DENIED on 403", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    })

    const result = await queryWorkItems("token", "myorg", "query")
    expect(result).toContain("PERMISSION_DENIED")
  })

  it("returns THROTTLED on 429", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    })

    const result = await queryWorkItems("token", "myorg", "query")
    expect(result).toContain("THROTTLED")
  })

  it("returns NETWORK_ERROR on fetch failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"))

    const result = await queryWorkItems("token", "myorg", "query")
    expect(result).toContain("NETWORK_ERROR")
  })

  it("returns NETWORK_ERROR on non-Error fetch failure", async () => {
    mockFetch.mockRejectedValueOnce("network failure string")

    const result = await queryWorkItems("token", "myorg", "query")
    expect(result).toContain("NETWORK_ERROR")
  })
})

describe("adoRequest", () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it("makes GET request and returns formatted JSON string", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ value: [{ id: 1, name: "repo1" }] }),
    })

    const result = await adoRequest("test-token", "GET", "myorg", "/_apis/git/repositories")

    expect(mockFetch).toHaveBeenCalledWith(
      "https://dev.azure.com/myorg/_apis/git/repositories?api-version=7.1",
      {
        method: "GET",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
      },
    )
    const parsed = JSON.parse(result)
    expect(parsed.value[0].name).toBe("repo1")
  })

  it("makes POST request with body (WIQL)", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ workItems: [{ id: 123 }] }),
    })

    const body = JSON.stringify({ query: "SELECT [System.Id] FROM WorkItems" })
    const result = await adoRequest("test-token", "POST", "myorg", "/_apis/wit/wiql", body)

    expect(mockFetch).toHaveBeenCalledWith(
      "https://dev.azure.com/myorg/_apis/wit/wiql?api-version=7.1",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body,
      },
    )
    const parsed = JSON.parse(result)
    expect(parsed.workItems[0].id).toBe(123)
  })

  it("makes PATCH request with body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 456, fields: { "System.Title": "Updated" } }),
    })

    const body = JSON.stringify([{ op: "replace", path: "/fields/System.Title", value: "Updated" }])
    const result = await adoRequest("test-token", "PATCH", "myorg", "/_apis/wit/workitems/456", body)

    expect(mockFetch).toHaveBeenCalledWith(
      "https://dev.azure.com/myorg/_apis/wit/workitems/456?api-version=7.1",
      expect.objectContaining({
        method: "PATCH",
        body,
      }),
    )
    const parsed = JSON.parse(result)
    expect(parsed.id).toBe(456)
  })

  it("makes DELETE request without body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    })

    await adoRequest("test-token", "DELETE", "myorg", "/_apis/wit/workitems/456")

    expect(mockFetch).toHaveBeenCalledWith(
      "https://dev.azure.com/myorg/_apis/wit/workitems/456?api-version=7.1",
      {
        method: "DELETE",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
      },
    )
  })

  it("does not duplicate api-version if already present in path", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ value: [] }),
    })

    await adoRequest("test-token", "GET", "myorg", "/_apis/wit/wiql?api-version=7.1")

    expect(mockFetch).toHaveBeenCalledWith(
      "https://dev.azure.com/myorg/_apis/wit/wiql?api-version=7.1",
      expect.any(Object),
    )
  })

  it("appends api-version with & when path already has query params", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ value: [] }),
    })

    await adoRequest("test-token", "GET", "myorg", "/_apis/git/repositories?$top=10")

    expect(mockFetch).toHaveBeenCalledWith(
      "https://dev.azure.com/myorg/_apis/git/repositories?$top=10&api-version=7.1",
      expect.any(Object),
    )
  })

  it("returns formatted JSON (pretty printed)", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ key: "value" }),
    })

    const result = await adoRequest("test-token", "GET", "myorg", "/_apis/projects")
    // Should be pretty-printed JSON
    expect(result).toContain("\n")
    expect(JSON.parse(result)).toEqual({ key: "value" })
  })

  it("returns AUTH_REQUIRED on 401", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    })

    const result = await adoRequest("bad-token", "GET", "myorg", "/_apis/projects")
    expect(result).toBe("AUTH_REQUIRED:ado")
  })

  it("returns PERMISSION_DENIED on 403", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    })

    const result = await adoRequest("token", "GET", "myorg", "/_apis/projects")
    expect(result).toContain("PERMISSION_DENIED")
  })

  it("returns THROTTLED on 429", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    })

    const result = await adoRequest("token", "GET", "myorg", "/_apis/projects")
    expect(result).toContain("THROTTLED")
  })

  it("returns SERVICE_ERROR on 500", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    })

    const result = await adoRequest("token", "GET", "myorg", "/_apis/projects")
    expect(result).toContain("SERVICE_ERROR")
  })

  it("returns NETWORK_ERROR on fetch failure", async () => {
    mockFetch.mockRejectedValue(new Error("network error"))

    const result = await adoRequest("token", "GET", "myorg", "/_apis/projects")
    expect(result).toContain("NETWORK_ERROR")
  })

  it("returns NETWORK_ERROR on non-Error fetch failure", async () => {
    mockFetch.mockRejectedValue("network failure string")

    const result = await adoRequest("token", "GET", "myorg", "/_apis/projects")
    expect(result).toContain("NETWORK_ERROR")
  })

  it("returns error string on generic 4xx", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
    })

    const result = await adoRequest("token", "POST", "myorg", "/_apis/wit/wiql", "bad")
    expect(result).toContain("ERROR")
    expect(result).toContain("400")
  })

  it("uses custom host when provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ count: 1 }),
    })

    await adoRequest("token", "GET", "myorg", "/_apis/graph/users", undefined, "vssps.dev.azure.com")

    expect(mockFetch).toHaveBeenCalledWith(
      "https://vssps.dev.azure.com/myorg/_apis/graph/users?api-version=7.1",
      expect.objectContaining({ method: "GET" }),
    )
  })
})

describe("discoverOrganizations", () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it("returns org names from Accounts API", async () => {
    // First call: profile to get publicAlias
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ publicAlias: "user-123" }),
      })
      // Second call: accounts list
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            { accountName: "org1" },
            { accountName: "org2" },
          ],
        }),
      })

    const result = await discoverOrganizations("test-token")
    expect(result).toEqual(["org1", "org2"])

    // Verify profile call
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("app.vssps.visualstudio.com/_apis/profile/profiles/me"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    )

    // Verify accounts call with memberId
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("app.vssps.visualstudio.com/_apis/accounts?memberId=user-123"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    )
  })

  it("returns empty array when no organizations found", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ publicAlias: "user-123" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      })

    const result = await discoverOrganizations("test-token")
    expect(result).toEqual([])
  })

  it("returns empty array when value is missing", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ publicAlias: "user-123" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      })

    const result = await discoverOrganizations("test-token")
    expect(result).toEqual([])
  })

  it("throws on profile API error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    })

    await expect(discoverOrganizations("bad-token")).rejects.toThrow()
  })

  it("throws on accounts API error", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ publicAlias: "user-123" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      })

    await expect(discoverOrganizations("test-token")).rejects.toThrow()
  })

  it("throws on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"))

    await expect(discoverOrganizations("test-token")).rejects.toThrow("network error")
  })

  it("throws when profile response is missing publicAlias", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ displayName: "User with no alias" }),
    })

    await expect(discoverOrganizations("test-token")).rejects.toThrow("ADO profile response missing publicAlias")
  })
})

describe("discoverProjects", () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it("returns project names from Projects API", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        value: [
          { name: "Project Alpha" },
          { name: "Project Beta" },
        ],
      }),
    })

    const result = await discoverProjects("test-token", "myorg")
    expect(result).toEqual(["Project Alpha", "Project Beta"])

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("dev.azure.com/myorg/_apis/projects"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    )
  })

  it("returns empty array when no projects found", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: [] }),
    })

    const result = await discoverProjects("test-token", "myorg")
    expect(result).toEqual([])
  })

  it("returns empty array when value is missing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    })

    const result = await discoverProjects("test-token", "myorg")
    expect(result).toEqual([])
  })

  it("throws on API error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    })

    await expect(discoverProjects("test-token", "myorg")).rejects.toThrow()
  })

  it("throws on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"))

    await expect(discoverProjects("test-token", "myorg")).rejects.toThrow("network error")
  })
})
