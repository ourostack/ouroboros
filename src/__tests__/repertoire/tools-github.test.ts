import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../repertoire/github-client", () => ({
  githubRequest: vi.fn(),
}))


import { githubRequest } from "../../repertoire/github-client"
import { githubToolDefinitions } from "../../repertoire/tools-github"

describe("githubToolDefinitions", () => {
  it("contains file_ouroboros_bug tool", () => {
    const names = githubToolDefinitions.map((d) => d.tool.function.name)
    expect(names).toContain("file_ouroboros_bug")
  })

  it("file_ouroboros_bug has correct parameter schema", () => {
    const def = githubToolDefinitions.find((d) => d.tool.function.name === "file_ouroboros_bug")!
    const params = def.tool.function.parameters as {
      type: string
      properties: Record<string, { type: string }>
      required: string[]
    }
    expect(params.properties).not.toHaveProperty("owner")
    expect(params.properties).not.toHaveProperty("repo")
    expect(params.properties).toHaveProperty("title")
    expect(params.properties).toHaveProperty("body")
    expect(params.properties).toHaveProperty("labels")
    expect(params.required).toContain("title")
  })

  it("file_ouroboros_bug has integration 'github'", () => {
    const def = githubToolDefinitions.find((d) => d.tool.function.name === "file_ouroboros_bug")!
    expect(def.integration).toBe("github")
  })

  it("file_ouroboros_bug has confirmationRequired true", () => {
    const def = githubToolDefinitions.find((d) => d.tool.function.name === "file_ouroboros_bug")!
    expect(def.confirmationRequired).toBe(true)
  })
})

describe("file_ouroboros_bug handler", () => {
  const handler = githubToolDefinitions.find(
    (d) => d.tool.function.name === "file_ouroboros_bug",
  )!.handler

  beforeEach(() => {
    vi.mocked(githubRequest).mockReset()
  })

  it("returns AUTH_REQUIRED:github when githubToken is missing", async () => {
    const result = await handler({ title: "test" }, { signin: async () => undefined } as any)
    expect(result).toContain("AUTH_REQUIRED:github")
  })

  it("returns AUTH_REQUIRED:github when ctx is undefined", async () => {
    const result = await handler({ title: "test" })
    expect(result).toContain("AUTH_REQUIRED:github")
  })

  it("calls githubRequest with correct method, path, and body on success", async () => {
    vi.mocked(githubRequest).mockResolvedValue('{"id": 1, "html_url": "https://github.com/o/r/issues/1"}')

    await handler(
      { title: "Bug fix" },
      { githubToken: "tok123", signin: async () => undefined } as any,
    )

    expect(githubRequest).toHaveBeenCalledWith(
      "tok123",
      "POST",
      "/repos/ouroborosbot/ouroboros/issues",
      JSON.stringify({ title: "Bug fix" }),
    )
  })

  it("includes body in request when provided", async () => {
    vi.mocked(githubRequest).mockResolvedValue('{"id": 2}')

    await handler(
      { title: "Issue", body: "Description here" },
      { githubToken: "tok", signin: async () => undefined } as any,
    )

    expect(githubRequest).toHaveBeenCalledWith(
      "tok",
      "POST",
      "/repos/ouroborosbot/ouroboros/issues",
      JSON.stringify({ title: "Issue", body: "Description here" }),
    )
  })

  it("splits comma-separated labels into array", async () => {
    vi.mocked(githubRequest).mockResolvedValue('{"id": 3}')

    await handler(
      { title: "Issue", labels: "bug, enhancement, urgent" },
      { githubToken: "tok", signin: async () => undefined } as any,
    )

    expect(githubRequest).toHaveBeenCalledWith(
      "tok",
      "POST",
      "/repos/ouroborosbot/ouroboros/issues",
      JSON.stringify({ title: "Issue", labels: ["bug", "enhancement", "urgent"] }),
    )
  })

  it("omits labels key when labels is empty string", async () => {
    vi.mocked(githubRequest).mockResolvedValue('{"id": 4}')

    await handler(
      { title: "Issue", labels: "" },
      { githubToken: "tok", signin: async () => undefined } as any,
    )

    expect(githubRequest).toHaveBeenCalledWith(
      "tok",
      "POST",
      "/repos/ouroborosbot/ouroboros/issues",
      JSON.stringify({ title: "Issue" }),
    )
  })

  it("omits labels key when labels is not provided", async () => {
    vi.mocked(githubRequest).mockResolvedValue('{"id": 5}')

    await handler(
      { title: "Issue" },
      { githubToken: "tok", signin: async () => undefined } as any,
    )

    expect(githubRequest).toHaveBeenCalledWith(
      "tok",
      "POST",
      "/repos/ouroborosbot/ouroboros/issues",
      JSON.stringify({ title: "Issue" }),
    )
  })

  it("includes both body and labels when both provided", async () => {
    vi.mocked(githubRequest).mockResolvedValue('{"id": 6}')

    await handler(
      { title: "Issue", body: "Details", labels: "bug" },
      { githubToken: "tok", signin: async () => undefined } as any,
    )

    expect(githubRequest).toHaveBeenCalledWith(
      "tok",
      "POST",
      "/repos/ouroborosbot/ouroboros/issues",
      JSON.stringify({ title: "Issue", body: "Details", labels: ["bug"] }),
    )
  })
})

