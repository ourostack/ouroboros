import { describe, it, expect, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import type { DoctorDeps, DoctorResult } from "../../../heart/daemon/doctor-types"
import {
  runDoctorChecks,
  checkDaemon,
  checkCliPath,
  checkAgents,
  checkSenses,
  checkHabits,
  checkSecurity,
  checkDisk,
} from "../../../heart/daemon/doctor"

function createMockDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
    readdirSync: vi.fn().mockReturnValue([]),
    statSync: vi.fn().mockReturnValue({ mode: 0o600, size: 100 }),
    checkSocketAlive: vi.fn().mockResolvedValue(false),
    socketPath: "/tmp/test.sock",
    bundlesRoot: "/tmp/bundles",
    secretsRoot: "/tmp/secrets",
    homedir: "/tmp/home",
    envPath: "/tmp/home/.ouro-cli/bin:/usr/bin",
    ...overrides,
  }
}

// ── Helper: build an existsSync that returns true only for specified paths ──
function existsFor(paths: string[]): (p: string) => boolean {
  const set = new Set(paths)
  return (p: string) => set.has(p)
}

// ── Helper: build a readdirSync that returns entries for specified dirs ──
function readdirFor(map: Record<string, string[]>): (p: string) => string[] {
  return (p: string) => map[p] ?? []
}

// ── Helper: build a readFileSync that returns content for specified paths ──
function readFileFor(map: Record<string, string>): (p: string) => string {
  return (p: string) => {
    if (p in map) return map[p]
    throw new Error(`ENOENT: ${p}`)
  }
}

// ── Helper: build a statSync that returns stats for specified paths ──
function statFor(map: Record<string, { mode: number; size: number }>): (p: string) => { mode: number; size: number } {
  return (p: string) => {
    if (p in map) return map[p]
    throw new Error(`ENOENT: ${p}`)
  }
}

describe("runDoctorChecks", () => {
  it("returns a DoctorResult with categories and summary", async () => {
    const deps = createMockDeps()
    const result: DoctorResult = await runDoctorChecks(deps)

    expect(result).toHaveProperty("categories")
    expect(result).toHaveProperty("summary")
    expect(Array.isArray(result.categories)).toBe(true)
    expect(result.categories.length).toBeGreaterThan(0)
    expect(typeof result.summary.passed).toBe("number")
    expect(typeof result.summary.warnings).toBe("number")
    expect(typeof result.summary.failed).toBe("number")
  })

  it("returns all 7 expected category names", async () => {
    const deps = createMockDeps()
    const result = await runDoctorChecks(deps)
    const names = result.categories.map((c) => c.name)

    expect(names).toContain("CLI")
    expect(names).toContain("Daemon")
    expect(names).toContain("Agents")
    expect(names).toContain("Senses")
    expect(names).toContain("Habits")
    expect(names).toContain("Security")
    expect(names).toContain("Disk")
  })

  it("summary counts match the total checks across categories", async () => {
    const deps = createMockDeps()
    const result = await runDoctorChecks(deps)

    const totalChecks = result.categories.reduce(
      (sum, cat) => sum + cat.checks.length,
      0,
    )
    const summaryTotal =
      result.summary.passed + result.summary.warnings + result.summary.failed

    expect(summaryTotal).toBe(totalChecks)
  })

  it("individual check failures do not crash the overall run", async () => {
    const deps = createMockDeps({
      existsSync: vi.fn().mockImplementation(() => {
        throw new Error("simulated fs explosion")
      }),
    })

    const result = await runDoctorChecks(deps)
    expect(result.categories.length).toBeGreaterThan(0)
    expect(result.summary.failed).toBeGreaterThan(0)
  })

  it("handles non-Error throws in category checkers", async () => {
    const deps = createMockDeps({
      existsSync: vi.fn().mockImplementation(() => {
        throw "string error" // eslint-disable-line no-throw-literal
      }),
    })

    const result = await runDoctorChecks(deps)
    expect(result.categories.length).toBeGreaterThan(0)
    // The crash detail should stringify the non-Error value
    const failedChecks = result.categories.flatMap((c) => c.checks).filter((c) => c.status === "fail")
    expect(failedChecks.some((c) => c.detail?.includes("string error"))).toBe(true)
  })
})

// ── CLI PATH checks ──

describe("checkCliPath", () => {
  it("passes when PATH resolves to the managed ouro wrapper", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/home/.ouro-cli/bin/ouro"]),
      readFileSync: readFileFor({
        "/tmp/home/.ouro-cli/bin/ouro": `#!/bin/sh
# Check for dev mode — if dev-config.json exists, dispatch to the dev repo
# Skip dev dispatch for "up" command (explicitly returns to production)
DEV_CONFIG="$HOME/.ouro-cli/dev-config.json"
if [ -f "$DEV_CONFIG" ] && [ "$1" != "up" ]; then
  DEV_REPO=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$DEV_CONFIG','utf-8')).repoPath)}catch{}" 2>/dev/null)
  DEV_ENTRY="$DEV_REPO/dist/heart/daemon/ouro-entry.js"
  if [ -n "$DEV_REPO" ] && [ -e "$DEV_ENTRY" ]; then
    exec node "$DEV_ENTRY" "$@"
  fi
fi
# Fall back to installed version
ENTRY="$HOME/.ouro-cli/CurrentVersion/node_modules/@ouro.bot/cli/dist/heart/daemon/ouro-entry.js"
if [ ! -e "$ENTRY" ]; then
  echo "ouro not installed. Run: npx ouro.bot" >&2
  exit 1
fi
exec node "$ENTRY" "$@"
`,
      }),
    })

    const cat = checkCliPath(deps)

    expect(cat.name).toBe("CLI")
    expect(cat.checks[0]).toMatchObject({
      label: "ouro PATH resolution",
      status: "pass",
    })
  })

  it("fails with exact remediation when PATH resolves to a stale external ouro first", () => {
    const deps = createMockDeps({
      envPath: "/opt/homebrew/bin:/tmp/home/.ouro-cli/bin:/usr/bin",
      existsSync: existsFor(["/opt/homebrew/bin/ouro", "/tmp/home/.ouro-cli/bin/ouro"]),
      readFileSync: readFileFor({
        "/opt/homebrew/bin/ouro": '#!/bin/sh\nexec npx --yes @ouro.bot/cli@0.1.0-alpha.323 "$@"\n',
        "/tmp/home/.ouro-cli/bin/ouro": "current",
      }),
    })

    const cat = checkCliPath(deps)

    expect(cat.checks[0].status).toBe("fail")
    expect(cat.checks[0].detail).toContain("PATH resolves ouro to /opt/homebrew/bin/ouro before /tmp/home/.ouro-cli/bin/ouro")
    expect(cat.checks[0].detail).toContain("move /tmp/home/.ouro-cli/bin before /opt/homebrew/bin in PATH")
    expect(cat.checks[0].detail).toContain("remove/replace /opt/homebrew/bin/ouro")
  })

  it("warns with exact remediation when ouro is not on PATH", () => {
    const deps = createMockDeps({
      envPath: "/usr/bin:/bin",
      existsSync: existsFor([]),
    })

    const cat = checkCliPath(deps)

    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("PATH does not resolve ouro")
    expect(cat.checks[0].detail).toContain("add /tmp/home/.ouro-cli/bin to PATH")
  })

  it("warns when envPath is omitted from doctor deps", () => {
    const deps = createMockDeps({
      envPath: undefined,
      existsSync: existsFor([]),
    })

    const cat = checkCliPath(deps)

    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("PATH does not resolve ouro")
  })
})

// ── Daemon checks ──

describe("checkDaemon", () => {
  it("passes when socket exists and responds", async () => {
    const deps = createMockDeps({
      existsSync: vi.fn().mockReturnValue(true),
      checkSocketAlive: vi.fn().mockResolvedValue(true),
    })
    const cat = await checkDaemon(deps)
    expect(cat.name).toBe("Daemon")
    expect(cat.checks).toHaveLength(2)
    expect(cat.checks[0].status).toBe("pass")
    expect(cat.checks[0].label).toContain("socket exists")
    expect(cat.checks[1].status).toBe("pass")
    expect(cat.checks[1].label).toContain("responsive")
  })

  it("fails when socket is missing", async () => {
    const deps = createMockDeps({
      existsSync: vi.fn().mockReturnValue(false),
    })
    const cat = await checkDaemon(deps)
    expect(cat.checks[0].status).toBe("fail")
    expect(cat.checks[1].status).toBe("fail")
    expect(cat.checks[1].detail).toContain("socket missing")
  })

  it("fails when socket exists but unresponsive", async () => {
    const deps = createMockDeps({
      existsSync: vi.fn().mockReturnValue(true),
      checkSocketAlive: vi.fn().mockResolvedValue(false),
    })
    const cat = await checkDaemon(deps)
    expect(cat.checks[0].status).toBe("pass")
    expect(cat.checks[1].status).toBe("fail")
    expect(cat.checks[1].detail).toContain("unresponsive")
  })
})

// ── Agent checks ──

describe("checkAgents", () => {
  it("fails when bundles dir does not exist", () => {
    const deps = createMockDeps({
      existsSync: existsFor([]),
    })
    const cat = checkAgents(deps)
    expect(cat.name).toBe("Agents")
    expect(cat.checks).toHaveLength(1)
    expect(cat.checks[0].status).toBe("fail")
    expect(cat.checks[0].detail).toContain("not found")
  })

  it("warns when bundles dir is empty", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles"]),
      readdirSync: readdirFor({ "/tmp/bundles": [] }),
    })
    const cat = checkAgents(deps)
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("no *.ouro")
  })

  it("passes for agent with valid agent.json", () => {
    const validConfig = JSON.stringify({
      version: 2,
      humanFacing: { provider: "anthropic", model: "claude-4" },
      agentFacing: { provider: "anthropic", model: "claude-4" },
    })
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/test.ouro/agent.json"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/agent.json": validConfig }),
    })
    const cat = checkAgents(deps)
    expect(cat.checks[0].status).toBe("pass")
    expect(cat.checks[0].detail).toBe("valid")
  })

  it("warns when agent.json is missing required fields", () => {
    const incompleteConfig = JSON.stringify({ version: 2 })
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/test.ouro/agent.json"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/agent.json": incompleteConfig }),
    })
    const cat = checkAgents(deps)
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("missing fields")
    expect(cat.checks[0].detail).toContain("humanFacing")
  })

  it("warns when humanFacing has missing sub-fields", () => {
    const config = JSON.stringify({
      version: 2,
      humanFacing: { provider: "anthropic" },
      agentFacing: { provider: "anthropic", model: "claude-4" },
    })
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/test.ouro/agent.json"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/agent.json": config }),
    })
    const cat = checkAgents(deps)
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("humanFacing.model")
  })

  it("warns when agentFacing has missing sub-fields", () => {
    const config = JSON.stringify({
      version: 2,
      humanFacing: { provider: "anthropic", model: "claude-4" },
      agentFacing: {},
    })
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/test.ouro/agent.json"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/agent.json": config }),
    })
    const cat = checkAgents(deps)
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("agentFacing.provider")
  })

  it("fails when agent.json is unparseable", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/test.ouro/agent.json"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/agent.json": "NOT JSON{{{" }),
    })
    const cat = checkAgents(deps)
    expect(cat.checks[0].status).toBe("fail")
    expect(cat.checks[0].detail).toContain("unparseable")
  })

  it("fails when agent.json is missing entirely", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
    })
    const cat = checkAgents(deps)
    expect(cat.checks[0].status).toBe("fail")
    expect(cat.checks[0].detail).toBe("missing")
  })

  it("warns when humanFacing.provider is missing but model is present", () => {
    const config = JSON.stringify({
      version: 2,
      humanFacing: { model: "claude-4" },
      agentFacing: { provider: "anthropic", model: "claude-4" },
    })
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/test.ouro/agent.json"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/agent.json": config }),
    })
    const cat = checkAgents(deps)
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("humanFacing.provider")
    expect(cat.checks[0].detail).not.toContain("humanFacing.model")
  })

  it("warns when version field is missing but facings are present", () => {
    const config = JSON.stringify({
      humanFacing: { provider: "anthropic", model: "claude-4" },
      agentFacing: { provider: "anthropic", model: "claude-4" },
    })
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/test.ouro/agent.json"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/agent.json": config }),
    })
    const cat = checkAgents(deps)
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("version")
  })

  it("skips agent.json that does not exist during senses check", async () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["noconfig.ouro"] }),
    })
    const cat = await checkSenses(deps)
    // Should produce a fallback warning since no senses were found
    expect(cat.checks[0].status).toBe("warn")
  })

  it("handles multiple agents with mixed health", () => {
    const validConfig = JSON.stringify({
      version: 2,
      humanFacing: { provider: "anthropic", model: "claude-4" },
      agentFacing: { provider: "anthropic", model: "claude-4" },
    })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/good.ouro/agent.json",
        // bad.ouro/agent.json does NOT exist
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["good.ouro", "bad.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/good.ouro/agent.json": validConfig }),
    })
    const cat = checkAgents(deps)
    expect(cat.checks).toHaveLength(2)
    expect(cat.checks[0].status).toBe("pass")
    expect(cat.checks[1].status).toBe("fail")
  })
})

// ── Senses checks ──

describe("checkSenses", () => {
  it("passes for well-formed senses config", async () => {
    const config = JSON.stringify({
      senses: {
        cli: { enabled: true },
        teams: { enabled: false },
        bluebubbles: { enabled: true },
      },
    })
    const secrets = JSON.stringify({
      bluebubbles: { serverUrl: "http://bluebubbles.local", password: "pw" },
    })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
        "/tmp/secrets/test/secrets.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
        "/tmp/secrets/test/secrets.json": secrets,
      }),
    })
    const cat = await checkSenses(deps)
    expect(cat.name).toBe("Senses")
    expect(cat.checks).toHaveLength(4)
    expect(cat.checks.every((c) => c.status === "pass")).toBe(true)
    expect(cat.checks[0].detail).toBe("enabled")
    expect(cat.checks[1].detail).toBe("disabled")
    expect(cat.checks[3]).toEqual(expect.objectContaining({
      label: "test.ouro bluebubbles config",
      detail: "http://bluebubbles.local",
    }))
  })

  it("warns when senses config is missing", async () => {
    const config = JSON.stringify({ version: 2 })
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/test.ouro/agent.json"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/agent.json": config }),
    })
    const cat = await checkSenses(deps)
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("no senses config")
  })

  it("fails when sense entry is malformed (not an object)", async () => {
    const config = JSON.stringify({
      senses: { cli: "not-an-object" },
    })
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/test.ouro/agent.json"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/agent.json": config }),
    })
    const cat = await checkSenses(deps)
    expect(cat.checks[0].status).toBe("fail")
    expect(cat.checks[0].detail).toContain("malformed")
  })

  it("warns when sense entry is missing enabled boolean", async () => {
    const config = JSON.stringify({
      senses: { cli: { port: 3000 } },
    })
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/test.ouro/agent.json"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/agent.json": config }),
    })
    const cat = await checkSenses(deps)
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("missing enabled")
  })

  it("warns when no agents have senses config", async () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles"]),
      readdirSync: readdirFor({ "/tmp/bundles": [] }),
    })
    const cat = await checkSenses(deps)
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("no agents")
  })

  it("fails when agent.json is unparseable for senses check", async () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/test.ouro/agent.json"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/agent.json": "BROKEN" }),
    })
    const cat = await checkSenses(deps)
    expect(cat.checks[0].status).toBe("fail")
    expect(cat.checks[0].detail).toContain("unparseable")
  })

  it("handles null sense entry", async () => {
    const config = JSON.stringify({
      senses: { cli: null },
    })
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/test.ouro/agent.json"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/agent.json": config }),
    })
    const cat = await checkSenses(deps)
    expect(cat.checks[0].status).toBe("fail")
    expect(cat.checks[0].detail).toContain("malformed")
  })

  it("actively probes enabled BlueBubbles upstreams and surfaces actionable failures", async () => {
    const config = JSON.stringify({
      senses: {
        bluebubbles: { enabled: true },
      },
    })
    const secrets = JSON.stringify({
      bluebubbles: {
        serverUrl: "http://bluebubbles.local",
        password: "pw",
      },
      bluebubblesChannel: {
        requestTimeoutMs: 1234,
      },
    })
    const fetchImpl = vi.fn().mockRejectedValue(new Error("fetch failed"))
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
        "/tmp/secrets/test/secrets.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
        "/tmp/secrets/test/secrets.json": secrets,
      }),
      fetchImpl,
    })

    const cat = await checkSenses(deps)

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://bluebubbles.local/api/v1/message/count?password=pw",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    )
    expect(cat.checks).toContainEqual(expect.objectContaining({
      label: "test.ouro bluebubbles upstream",
      status: "fail",
      detail: expect.stringContaining("Cannot reach BlueBubbles at http://bluebubbles.local"),
    }))
    expect(cat.checks).toContainEqual(expect.objectContaining({
      label: "test.ouro bluebubbles upstream",
      detail: expect.stringContaining("Check `bluebubbles.serverUrl`"),
    }))
  })

  it("passes enabled BlueBubbles upstream checks when the server responds", async () => {
    const config = JSON.stringify({
      senses: {
        bluebubbles: { enabled: true },
      },
    })
    const secrets = JSON.stringify({
      bluebubbles: {
        serverUrl: "http://bluebubbles.local",
        password: "pw",
      },
    })
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }))
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
        "/tmp/secrets/test/secrets.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
        "/tmp/secrets/test/secrets.json": secrets,
      }),
      fetchImpl,
    })

    const cat = await checkSenses(deps)

    expect(cat.checks).toContainEqual(expect.objectContaining({
      label: "test.ouro bluebubbles upstream",
      status: "pass",
      detail: "upstream reachable",
    }))
  })

  it("fails enabled BlueBubbles config checks before probing when secrets fields are missing", async () => {
    const config = JSON.stringify({
      senses: {
        bluebubbles: { enabled: true },
      },
    })
    const secrets = JSON.stringify({
      bluebubbles: {
        serverUrl: "",
      },
    })
    const fetchImpl = vi.fn()
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
        "/tmp/secrets/test/secrets.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
        "/tmp/secrets/test/secrets.json": secrets,
      }),
      fetchImpl,
    })

    const cat = await checkSenses(deps)

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(cat.checks).toContainEqual(expect.objectContaining({
      label: "test.ouro bluebubbles config",
      status: "fail",
      detail: "missing bluebubbles.serverUrl/bluebubbles.password",
    }))
  })

  it("fails enabled BlueBubbles config checks when secrets.json is missing", async () => {
    const config = JSON.stringify({
      senses: {
        bluebubbles: { enabled: true },
      },
    })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/agent.json": config }),
      fetchImpl: vi.fn(),
    })

    const cat = await checkSenses(deps)

    expect(cat.checks).toContainEqual(expect.objectContaining({
      label: "test.ouro bluebubbles config",
      status: "fail",
      detail: "missing secrets.json",
    }))
  })

  it("fails enabled BlueBubbles config checks when secrets.json is unparseable", async () => {
    const config = JSON.stringify({
      senses: {
        bluebubbles: { enabled: true },
      },
    })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
        "/tmp/secrets/test/secrets.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
        "/tmp/secrets/test/secrets.json": "not json",
      }),
      fetchImpl: vi.fn(),
    })

    const cat = await checkSenses(deps)

    expect(cat.checks).toContainEqual(expect.objectContaining({
      label: "test.ouro bluebubbles config",
      status: "fail",
      detail: "secrets.json unparseable",
    }))
  })
})

// ── Habits checks ──

describe("checkHabits", () => {
  it("passes when habits dir exists and plists present", () => {
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/habits",
        "/tmp/home/Library/LaunchAgents",
      ]),
      readdirSync: readdirFor({
        "/tmp/bundles": ["test.ouro"],
        "/tmp/home/Library/LaunchAgents": ["bot.ouro.test.daily.plist"],
      }),
    })
    const cat = checkHabits(deps)
    expect(cat.name).toBe("Habits")
    expect(cat.checks.some((c) => c.label.includes("habits dir") && c.status === "pass")).toBe(true)
    expect(cat.checks.some((c) => c.label.includes("launchd") && c.status === "pass")).toBe(true)
  })

  it("fails when habits dir exists but no plists found", () => {
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/habits",
        "/tmp/home/Library/LaunchAgents",
      ]),
      readdirSync: readdirFor({
        "/tmp/bundles": ["test.ouro"],
        "/tmp/home/Library/LaunchAgents": ["com.other.plist"],
      }),
    })
    const cat = checkHabits(deps)
    expect(cat.checks.some((c) => c.label.includes("launchd") && c.status === "fail")).toBe(true)
  })

  it("warns when habits dir is missing", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
    })
    const cat = checkHabits(deps)
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("no habits directory")
  })

  it("skips launchd check when LaunchAgents dir does not exist", () => {
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/habits",
        // LaunchAgents NOT in the set
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
    })
    const cat = checkHabits(deps)
    // Should have habits dir check but no launchd check
    expect(cat.checks).toHaveLength(1)
    expect(cat.checks[0].label).toContain("habits dir")
    expect(cat.checks[0].status).toBe("pass")
  })

  it("warns when no agents found", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles"]),
      readdirSync: readdirFor({ "/tmp/bundles": [] }),
    })
    const cat = checkHabits(deps)
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("no agents")
  })
})

// ── Security checks ──

describe("checkSecurity", () => {
  it("passes when secrets.json exists with proper permissions and no leaked creds", () => {
    const config = JSON.stringify({ version: 2, humanFacing: { provider: "anthropic" } })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/secrets/test/secrets.json",
        "/tmp/bundles/test.ouro/agent.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      statSync: statFor({ "/tmp/secrets/test/secrets.json": { mode: 0o600, size: 100 } }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/agent.json": config }),
    })
    const cat = checkSecurity(deps)
    expect(cat.name).toBe("Security")
    expect(cat.checks.find((c) => c.label.includes("perms"))?.status).toBe("pass")
    expect(cat.checks.find((c) => c.label.includes("credential leak"))?.status).toBe("pass")
  })

  it("warns when secrets.json is world-readable", () => {
    const config = JSON.stringify({ version: 2 })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/secrets/test/secrets.json",
        "/tmp/bundles/test.ouro/agent.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      statSync: statFor({ "/tmp/secrets/test/secrets.json": { mode: 0o644, size: 100 } }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/agent.json": config }),
    })
    const cat = checkSecurity(deps)
    expect(cat.checks.find((c) => c.label.includes("perms"))?.status).toBe("warn")
    expect(cat.checks.find((c) => c.label.includes("perms"))?.detail).toContain("world-readable")
  })

  it("does not fail when legacy secrets.json is missing", () => {
    const config = JSON.stringify({ version: 2 })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/agent.json": config }),
    })
    const cat = checkSecurity(deps)
    expect(cat.checks.find((c) => c.label.includes("legacy secrets.json perms"))).toBeUndefined()
    expect(cat.checks.find((c) => c.label.includes("credential leak"))?.status).toBe("pass")
  })

  it("warns when agent.json contains credential keys", () => {
    const config = JSON.stringify({ version: 2, apiKey: "sk-test123" })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/secrets/test/secrets.json",
        "/tmp/bundles/test.ouro/agent.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      statSync: statFor({ "/tmp/secrets/test/secrets.json": { mode: 0o600, size: 100 } }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/agent.json": config }),
    })
    const cat = checkSecurity(deps)
    expect(cat.checks.find((c) => c.label.includes("credential leak"))?.status).toBe("warn")
    expect(cat.checks.find((c) => c.label.includes("credential leak"))?.detail).toContain("apiKey")
  })

  it("fails credential leak check when agent.json unreadable", () => {
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/secrets/test/secrets.json",
        "/tmp/bundles/test.ouro/agent.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      statSync: statFor({ "/tmp/secrets/test/secrets.json": { mode: 0o600, size: 100 } }),
      readFileSync: vi.fn().mockImplementation(() => { throw new Error("EACCES") }),
    })
    const cat = checkSecurity(deps)
    expect(cat.checks.find((c) => c.label.includes("credential leak"))?.status).toBe("fail")
    expect(cat.checks.find((c) => c.label.includes("credential leak"))?.detail).toContain("could not read")
  })

  it("skips credential leak check when agent.json does not exist", () => {
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/secrets/test/secrets.json",
        // agent.json NOT in the set
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      statSync: statFor({ "/tmp/secrets/test/secrets.json": { mode: 0o600, size: 100 } }),
    })
    const cat = checkSecurity(deps)
    // Should have perms check but no credential leak check
    expect(cat.checks.find((c) => c.label.includes("perms"))?.status).toBe("pass")
    expect(cat.checks.find((c) => c.label.includes("credential leak"))).toBeUndefined()
  })

  it("does not inspect the removed machine-wide provider credential pool", () => {
    const config = JSON.stringify({ version: 2 })
    const readFileSync = vi.fn(readFileFor({
      "/tmp/bundles/test.ouro/agent.json": config,
      "/tmp/secrets/providers.json": "not-json-with-secret-token",
    }))
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
        "/tmp/secrets/test/secrets.json",
        "/tmp/secrets/providers.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      statSync: statFor({
        "/tmp/secrets/test/secrets.json": { mode: 0o600, size: 100 },
        "/tmp/secrets/providers.json": { mode: 0o644, size: 26 },
      }),
      readFileSync,
    })

    const cat = checkSecurity(deps)

    expect(readFileSync).not.toHaveBeenCalledWith("/tmp/secrets/providers.json")
    expect(cat.checks.find((c) => c.label.includes("machine provider credentials"))).toBeUndefined()
  })

  it("passes provider state leak scan when no credential-looking keys are present", () => {
    const config = JSON.stringify({ version: 2 })
    const providerStatePath = "/tmp/bundles/test.ouro/state/providers.json"
    const providerStateWithoutLeak = JSON.stringify({
      schemaVersion: 1,
      machineId: "machine_unit6",
      updatedAt: "2026-04-12T22:21:00.000Z",
      lanes: {
        outward: {
          provider: "anthropic",
          model: "claude-opus-4-6",
          source: "bootstrap",
          updatedAt: "2026-04-12T22:21:00.000Z",
        },
        inner: {
          provider: "minimax",
          model: "MiniMax-M2.5",
          source: "bootstrap",
          updatedAt: "2026-04-12T22:21:00.000Z",
        },
      },
      readiness: {},
    })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
        "/tmp/bundles/test.ouro/state/providers.json",
        "/tmp/secrets/test/secrets.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      statSync: statFor({ "/tmp/secrets/test/secrets.json": { mode: 0o600, size: 100 } }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
        [providerStatePath]: providerStateWithoutLeak,
      }),
    })

    const cat = checkSecurity(deps)

    expect(cat.checks).toContainEqual(expect.objectContaining({
      label: "test.ouro state/providers.json credential leak",
      status: "pass",
      detail: "no credential keys",
    }))
  })

  it("warns when bundle provider state contains credential-looking keys without printing leaked values", () => {
    const config = JSON.stringify({ version: 2 })
    const providerStatePath = "/tmp/bundles/test.ouro/state/providers.json"
    const providerStateWithLeak = JSON.stringify({
      schemaVersion: 1,
      machineId: "machine_unit6",
      updatedAt: "2026-04-12T22:21:00.000Z",
      lanes: {
        outward: {
          provider: "anthropic",
          model: "claude-opus-4-6",
          source: "bootstrap",
          updatedAt: "2026-04-12T22:21:00.000Z",
        },
        inner: {
          provider: "minimax",
          model: "MiniMax-M2.5",
          source: "bootstrap",
          updatedAt: "2026-04-12T22:21:00.000Z",
        },
      },
      readiness: {},
      apiKey: "leaked-provider-state-secret",
    })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
        "/tmp/bundles/test.ouro/state/providers.json",
        "/tmp/secrets/test/secrets.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      statSync: statFor({ "/tmp/secrets/test/secrets.json": { mode: 0o600, size: 100 } }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
        [providerStatePath]: providerStateWithLeak,
      }),
    })

    const cat = checkSecurity(deps)

    expect(cat.checks).toContainEqual(expect.objectContaining({
      label: "test.ouro state/providers.json credential leak",
      status: "warn",
      detail: expect.stringContaining("apiKey"),
    }))
    expect(JSON.stringify(cat)).not.toContain("leaked-provider-state-secret")
  })

  it("fails provider state leak scan when state/providers.json is unreadable", () => {
    const config = JSON.stringify({ version: 2 })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
        "/tmp/bundles/test.ouro/state/providers.json",
        "/tmp/secrets/test/secrets.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      statSync: statFor({ "/tmp/secrets/test/secrets.json": { mode: 0o600, size: 100 } }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
      }),
    })

    const cat = checkSecurity(deps)

    expect(cat.checks).toContainEqual(expect.objectContaining({
      label: "test.ouro state/providers.json credential leak",
      status: "fail",
      detail: "could not read state/providers.json",
    }))
  })

  it("warns when no agents found", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles"]),
      readdirSync: readdirFor({ "/tmp/bundles": [] }),
    })
    const cat = checkSecurity(deps)
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("no agents")
  })
})

// ── Disk checks ──

describe("checkDisk", () => {
  it("passes when logs dir exists with reasonable size", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/home/.ouro-cli/logs", "/tmp/bundles"]),
      readdirSync: readdirFor({ "/tmp/home/.ouro-cli/logs": ["daemon.log"] }),
      statSync: statFor({
        "/tmp/home/.ouro-cli/logs/daemon.log": { mode: 0o644, size: 5000 },
      }),
    })
    const cat = checkDisk(deps)
    expect(cat.name).toBe("Disk")
    expect(cat.checks.find((c) => c.label.includes("log size"))?.status).toBe("pass")
    expect(cat.checks.find((c) => c.label.includes("bundles root"))?.status).toBe("pass")
  })

  it("warns when log directory is missing", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles"]),
    })
    const cat = checkDisk(deps)
    expect(cat.checks.find((c) => c.label.includes("logs dir"))?.status).toBe("warn")
  })

  it("warns when log files are over 100MB", () => {
    const bigSize = 150 * 1024 * 1024 // 150MB
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/home/.ouro-cli/logs", "/tmp/bundles"]),
      readdirSync: readdirFor({ "/tmp/home/.ouro-cli/logs": ["big.log"] }),
      statSync: statFor({
        "/tmp/home/.ouro-cli/logs/big.log": { mode: 0o644, size: bigSize },
      }),
    })
    const cat = checkDisk(deps)
    expect(cat.checks.find((c) => c.label.includes("log size"))?.status).toBe("warn")
    expect(cat.checks.find((c) => c.label.includes("log size"))?.detail).toContain("prune")
  })

  it("fails when log files are over 500MB", () => {
    const hugeSize = 600 * 1024 * 1024 // 600MB
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/home/.ouro-cli/logs", "/tmp/bundles"]),
      readdirSync: readdirFor({ "/tmp/home/.ouro-cli/logs": ["huge.log"] }),
      statSync: statFor({
        "/tmp/home/.ouro-cli/logs/huge.log": { mode: 0o644, size: hugeSize },
      }),
    })
    const cat = checkDisk(deps)
    expect(cat.checks.find((c) => c.label.includes("log size"))?.status).toBe("fail")
    expect(cat.checks.find((c) => c.label.includes("log size"))?.detail).toContain("500MB")
  })

  it("warns when bundles root missing", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/home/.ouro-cli/logs"]),
      readdirSync: readdirFor({ "/tmp/home/.ouro-cli/logs": [] }),
    })
    const cat = checkDisk(deps)
    expect(cat.checks.find((c) => c.label.includes("bundles root"))?.status).toBe("warn")
  })

  it("handles statSync failure on individual log files gracefully", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/home/.ouro-cli/logs", "/tmp/bundles"]),
      readdirSync: readdirFor({ "/tmp/home/.ouro-cli/logs": ["bad.log"] }),
      statSync: vi.fn().mockImplementation(() => { throw new Error("EACCES") }),
    })
    const cat = checkDisk(deps)
    // Should still produce a result (0 bytes counted)
    expect(cat.checks.find((c) => c.label.includes("log size"))?.status).toBe("pass")
  })

  it("handles readdirSync failure on logs dir gracefully", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/home/.ouro-cli/logs", "/tmp/bundles"]),
      readdirSync: vi.fn().mockImplementation(() => { throw new Error("EACCES") }),
    })
    const cat = checkDisk(deps)
    // Should still produce a result with 0 bytes (catch absorbs error)
    expect(cat.checks.find((c) => c.label.includes("log size"))?.status).toBe("pass")
  })
})
