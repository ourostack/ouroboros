import { afterEach, describe, it, expect, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

const mockRuntimeConfigs = vi.hoisted(() => new Map<string, any>())
const mockMachineRuntimeConfigs = vi.hoisted(() => new Map<string, any>())
vi.mock("../../../heart/runtime-credentials", () => ({
  refreshRuntimeCredentialConfig: vi.fn(async (agentName: string) => mockRuntimeConfigs.get(agentName) ?? {
    ok: false,
    reason: "missing",
    itemPath: `vault:${agentName}:runtime/config`,
    error: `no runtime credentials stored at vault:${agentName}:runtime/config`,
  }),
  refreshMachineRuntimeCredentialConfig: vi.fn(async (agentName: string, machineId: string) => mockMachineRuntimeConfigs.get(agentName) ?? {
    ok: false,
    reason: "missing",
    itemPath: `vault:${agentName}:runtime/machines/${machineId}/config`,
    error: `no machine runtime credentials stored at vault:${agentName}:runtime/machines/${machineId}/config`,
  }),
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
  checkTrips,
  checkMailroom,
  checkFriends,
  checkDisk,
  checkLifecycle,
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

function seedRuntimeConfig(agentName: string, config: Record<string, unknown>): void {
  mockRuntimeConfigs.set(agentName, {
    ok: true,
    itemPath: `vault:${agentName}:runtime/config`,
    config,
    revision: "runtime_test",
    updatedAt: "2026-04-14T00:00:00.000Z",
  })
  mockMachineRuntimeConfigs.set(agentName, {
    ok: true,
    itemPath: `vault:${agentName}:runtime/machines/machine_test/config`,
    config,
    revision: "runtime_machine_test",
    updatedAt: "2026-04-14T00:00:00.000Z",
  })
}

afterEach(() => {
  mockRuntimeConfigs.clear()
  mockMachineRuntimeConfigs.clear()
})

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
  echo "ouro not installed. Run: npx ouro.bot@latest" >&2
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
    seedRuntimeConfig("test", {
      bluebubbles: { serverUrl: "http://bluebubbles.local", password: "pw" },
    })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
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

  it("fails enabled Mail config checks when hosted Blob reader fields are missing", async () => {
    const config = JSON.stringify({
      senses: {
        mail: { enabled: true },
      },
    })
    seedRuntimeConfig("test", {
      workSubstrate: { mode: "hosted" },
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        privateKeys: {},
      },
    })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
      }),
    })

    const cat = await checkSenses(deps)

    expect(cat.checks).toContainEqual(expect.objectContaining({
      label: "test.ouro mail config",
      status: "fail",
      detail: "missing mailroom.privateKeys/mailroom.azureAccountUrl for hosted Blob reader",
    }))
  })

  it("fails enabled Mail config checks when mailbox identity is missing", async () => {
    const config = JSON.stringify({
      senses: {
        mail: { enabled: true },
      },
    })
    seedRuntimeConfig("test", {
      mailroom: {
        privateKeys: { mail_slugger: "PRIVATE KEY" },
      },
    })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
      }),
    })

    const cat = await checkSenses(deps)

    expect(cat.checks).toContainEqual(expect.objectContaining({
      label: "test.ouro mail config",
      status: "fail",
      detail: "missing mailroom.mailboxAddress",
    }))
  })

  it("passes enabled Mail config checks and reports hosted Blob plus autonomy kill switch state", async () => {
    const config = JSON.stringify({
      senses: {
        mail: { enabled: true },
      },
    })
    seedRuntimeConfig("test", {
      workSubstrate: { mode: "hosted" },
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        privateKeys: { mail_slugger: "PRIVATE KEY" },
        azureAccountUrl: "https://mailstore.blob.core.windows.net",
        azureContainer: "mailroom",
        autonomousSendPolicy: {
          enabled: true,
          killSwitch: true,
        },
      },
    })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
      }),
    })

    const cat = await checkSenses(deps)

    expect(cat.checks).toContainEqual(expect.objectContaining({
      label: "test.ouro mail config",
      status: "pass",
      detail: "slugger@ouro.bot; hosted azure-blob https://mailstore.blob.core.windows.net/mailroom; autonomy enabled; kill switch on",
    }))
  })

  it("passes enabled local Mail config checks and reports autonomy fallback state", async () => {
    const config = JSON.stringify({
      senses: {
        mail: { enabled: true },
      },
    })
    seedRuntimeConfig("test", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        privateKeys: { mail_slugger: "PRIVATE KEY" },
        storePath: "/tmp/bundles/test.ouro/state/mailroom",
      },
    })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
      }),
    })

    const cat = await checkSenses(deps)

    expect(cat.checks).toContainEqual(expect.objectContaining({
      label: "test.ouro mail config",
      status: "pass",
      detail: "slugger@ouro.bot; local file Mailroom; autonomy disabled; kill switch off",
    }))
  })

  it("fails enabled Mail config checks when portable runtime config is unavailable", async () => {
    const config = JSON.stringify({
      senses: {
        mail: { enabled: true },
      },
    })
    mockRuntimeConfigs.set("test", {
      ok: false,
      reason: "locked",
      itemPath: "vault:test:runtime/config",
      error: "vault is locked",
    })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
      }),
    })

    const cat = await checkSenses(deps)

    expect(cat.checks).toContainEqual(expect.objectContaining({
      label: "test.ouro mail config",
      status: "fail",
      detail: "runtime config unavailable: vault is locked",
    }))
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
    seedRuntimeConfig("test", {
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
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
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
    seedRuntimeConfig("test", {
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
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
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
    seedRuntimeConfig("test", {
      bluebubbles: {
        serverUrl: "",
      },
    })
    const fetchImpl = vi.fn()
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
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

  it("treats missing enabled BlueBubbles machine config as not attached", async () => {
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
      status: "pass",
      detail: "not attached on this machine",
    }))
  })

  it("fails enabled BlueBubbles config checks when machine runtime config is invalid", async () => {
    const config = JSON.stringify({
      senses: {
        bluebubbles: { enabled: true },
      },
    })
    mockMachineRuntimeConfigs.set("test", {
      ok: false,
      reason: "invalid",
      itemPath: "vault:test:runtime/machines/machine_test/config",
      error: "runtime credential payload is malformed",
    })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
      }),
      fetchImpl: vi.fn(),
    })

    const cat = await checkSenses(deps)

    expect(cat.checks).toContainEqual(expect.objectContaining({
      label: "test.ouro bluebubbles config",
      status: "fail",
      detail: "machine runtime config unavailable: runtime credential payload is malformed",
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
  it("passes when agent.json has no leaked creds", () => {
    const config = JSON.stringify({ version: 2, humanFacing: { provider: "anthropic" } })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/agent.json": config }),
    })
    const cat = checkSecurity(deps)
    expect(cat.name).toBe("Security")
    expect(cat.checks.find((c) => c.label.includes("credential leak"))?.status).toBe("pass")
  })

  it("does not inspect removed local credential files", () => {
    const config = JSON.stringify({ version: 2 })
    const readFileSync = vi.fn(readFileFor({ "/tmp/bundles/test.ouro/agent.json": config }))
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
        "/tmp/home/retired/test/secrets.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync,
    })
    const cat = checkSecurity(deps)
    expect(readFileSync).toHaveBeenCalledTimes(1)
    expect(cat.checks.find((c) => c.label.includes("credential leak"))?.status).toBe("pass")
  })

  it("warns when agent.json contains credential keys", () => {
    const config = JSON.stringify({ version: 2, apiKey: "sk-test123" })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
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
        "/tmp/bundles/test.ouro/agent.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
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
        // agent.json NOT in the set
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
    })
    const cat = checkSecurity(deps)
    expect(cat.checks.find((c) => c.label.includes("credential leak"))).toBeUndefined()
  })

  it("does not inspect the removed machine-wide credential location", () => {
    const config = JSON.stringify({ version: 2 })
    const readFileSync = vi.fn(readFileFor({
      "/tmp/bundles/test.ouro/agent.json": config,
      "/tmp/secrets/agent.json": "not-json-with-secret-token",
    }))
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
        "/tmp/secrets/test/secrets.json",
        "/tmp/secrets/agent.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      statSync: statFor({
        "/tmp/secrets/test/secrets.json": { mode: 0o600, size: 100 },
        "/tmp/secrets/agent.json": { mode: 0o644, size: 26 },
      }),
      readFileSync,
    })

    const cat = checkSecurity(deps)

    expect(readFileSync).not.toHaveBeenCalledWith("/tmp/secrets/agent.json")
    expect(cat.checks.find((c) => c.label.includes("machine provider credentials"))).toBeUndefined()
  })

  it("passes agent.json credential leak scan when no credential-looking keys are present", () => {
    const config = JSON.stringify({ version: 2 })
    const agentProviderSelectionPath = "/tmp/bundles/test.ouro/agent.json"
    const agentProviderSelectionWithoutLeak = JSON.stringify({
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
        "/tmp/bundles/test.ouro/agent.json",
        "/tmp/secrets/test/secrets.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      statSync: statFor({ "/tmp/secrets/test/secrets.json": { mode: 0o600, size: 100 } }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
        [agentProviderSelectionPath]: agentProviderSelectionWithoutLeak,
      }),
    })

    const cat = checkSecurity(deps)

    expect(cat.checks).toContainEqual(expect.objectContaining({
      label: "test.ouro credential leak",
      status: "pass",
      detail: "no credential keys in agent.json",
    }))
  })

  it("warns when bundle agent.json contains credential-looking keys without printing leaked values", () => {
    const config = JSON.stringify({ version: 2 })
    const agentProviderSelectionPath = "/tmp/bundles/test.ouro/agent.json"
    const agentProviderSelectionWithLeak = JSON.stringify({
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
      apiKey: "leaked-agent.json provider selection-secret",
    })
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
        "/tmp/bundles/test.ouro/agent.json",
        "/tmp/secrets/test/secrets.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      statSync: statFor({ "/tmp/secrets/test/secrets.json": { mode: 0o600, size: 100 } }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/agent.json": config,
        [agentProviderSelectionPath]: agentProviderSelectionWithLeak,
      }),
    })

    const cat = checkSecurity(deps)

    expect(cat.checks).toContainEqual(expect.objectContaining({
      label: "test.ouro credential leak",
      status: "warn",
      detail: expect.stringContaining("apiKey"),
    }))
    expect(JSON.stringify(cat)).not.toContain("leaked-agent.json provider selection-secret")
  })

  it("fails agent.json credential leak scan when agent.json is unreadable", () => {
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/agent.json",
        "/tmp/bundles/test.ouro/agent.json",
        "/tmp/secrets/test/secrets.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      statSync: statFor({ "/tmp/secrets/test/secrets.json": { mode: 0o600, size: 100 } }),
      readFileSync: ((target: string) => {
        if (target === "/tmp/bundles/test.ouro/agent.json") throw new Error("unreadable")
        throw new Error(`unexpected read: ${target}`)
      }),
    })

    const cat = checkSecurity(deps)

    expect(cat.checks).toContainEqual(expect.objectContaining({
      label: "test.ouro credential leak",
      status: "fail",
      detail: "could not read agent.json",
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

// ── Trip ledger checks ──

describe("checkTrips", () => {
  const ledgerJson = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
    ledgerId: "ledger_slugger_xyz",
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----",
    ...overrides,
  })

  const nestedLedgerJson = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
    ledger: { ledgerId: "ledger_slugger_nested" },
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----",
    ...overrides,
  })

  it("warns when no agents are found", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles"]),
      readdirSync: readdirFor({ "/tmp/bundles": [] }),
    })
    const cat = checkTrips(deps)
    expect(cat.name).toBe("Trips")
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("no agent bundles")
  })

  it("passes when an agent has no trip ledger directory yet (optional feature)", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
    })
    const cat = checkTrips(deps)
    expect(cat.checks[0].status).toBe("pass")
    expect(cat.checks[0].detail).toContain("no ledger directory")
  })

  it("warns when trips dir exists but ledger.json is missing", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/test.ouro/state/trips"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
    })
    const cat = checkTrips(deps)
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("ledger.json missing")
  })

  it("fails when ledger.json is unparseable", () => {
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/state/trips",
        "/tmp/bundles/test.ouro/state/trips/ledger.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/state/trips/ledger.json": "{not json" }),
    })
    const cat = checkTrips(deps)
    expect(cat.checks[0].status).toBe("fail")
    expect(cat.checks[0].detail).toContain("not valid JSON")
  })

  it("warns when ledger.json is missing the ledgerId field", () => {
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/state/trips",
        "/tmp/bundles/test.ouro/state/trips/ledger.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/state/trips/ledger.json": JSON.stringify({ privateKeyPem: "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----" }) }),
    })
    const cat = checkTrips(deps)
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("ledgerId")
  })

  it("fails when privateKeyPem is missing — encrypted records cannot be read", () => {
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/state/trips",
        "/tmp/bundles/test.ouro/state/trips/ledger.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/state/trips/ledger.json": JSON.stringify({ ledgerId: "lg" }) }),
    })
    const cat = checkTrips(deps)
    expect(cat.checks[0].status).toBe("fail")
    expect(cat.checks[0].detail).toContain("privateKeyPem missing")
  })

  it("passes with record count when ledger is healthy", () => {
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/state/trips",
        "/tmp/bundles/test.ouro/state/trips/ledger.json",
        "/tmp/bundles/test.ouro/state/trips/records",
      ]),
      readdirSync: readdirFor({
        "/tmp/bundles": ["test.ouro"],
        "/tmp/bundles/test.ouro/state/trips/records": ["trip_a.json", "trip_b.json", "ignore.txt"],
      }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/state/trips/ledger.json": ledgerJson() }),
    })
    const cat = checkTrips(deps)
    expect(cat.checks[0].status).toBe("pass")
    expect(cat.checks[0].detail).toContain("ledger_slugger_xyz")
    expect(cat.checks[0].detail).toContain("2 records")
  })

  it("accepts the current nested trip ledger schema", () => {
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/state/trips",
        "/tmp/bundles/test.ouro/state/trips/ledger.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/state/trips/ledger.json": nestedLedgerJson() }),
    })
    const cat = checkTrips(deps)
    expect(cat.checks[0].status).toBe("pass")
    expect(cat.checks[0].detail).toContain("ledger_slugger_nested")
  })
})

// ── Mailroom checks ──

describe("checkMailroom", () => {
  const registryJson = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
    schemaVersion: 1,
    domain: "ouro.bot",
    mailboxes: [{ agentId: "test", mailboxId: "mb_x", canonicalAddress: "test@ouro.bot", keyId: "k", publicKeyPem: "pem", defaultPlacement: "imbox" }],
    sourceGrants: [],
    ...overrides,
  })

  it("warns when no agents found", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles"]),
      readdirSync: readdirFor({ "/tmp/bundles": [] }),
    })
    const cat = checkMailroom(deps)
    expect(cat.name).toBe("Mailroom")
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("no agent bundles")
  })

  it("passes when no mailroom dir (mail not connected)", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
    })
    const cat = checkMailroom(deps)
    expect(cat.checks[0].status).toBe("pass")
    expect(cat.checks[0].detail).toContain("not connected")
  })

  it("warns when state/mailroom dir exists but no registry.json", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/test.ouro/state/mailroom"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
    })
    const cat = checkMailroom(deps)
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("registry.json missing")
  })

  it("fails when registry.json is unparseable", () => {
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/state/mailroom",
        "/tmp/bundles/test.ouro/state/mailroom/registry.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/state/mailroom/registry.json": "{not json" }),
    })
    const cat = checkMailroom(deps)
    expect(cat.checks[0].status).toBe("fail")
    expect(cat.checks[0].detail).toContain("not valid JSON")
  })

  it("warns when registry has zero mailboxes", () => {
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/state/mailroom",
        "/tmp/bundles/test.ouro/state/mailroom/registry.json",
      ]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/test.ouro/state/mailroom/registry.json": registryJson({ mailboxes: [] }) }),
    })
    const cat = checkMailroom(deps)
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("no mailboxes")
  })

  it("passes with mailbox / grant / message counts when healthy", () => {
    const deps = createMockDeps({
      existsSync: existsFor([
        "/tmp/bundles",
        "/tmp/bundles/test.ouro/state/mailroom",
        "/tmp/bundles/test.ouro/state/mailroom/registry.json",
        "/tmp/bundles/test.ouro/state/mailroom/messages",
      ]),
      readdirSync: readdirFor({
        "/tmp/bundles": ["test.ouro"],
        "/tmp/bundles/test.ouro/state/mailroom/messages": ["mail_a.json", "mail_b.json", "mail_c.json", "skip.txt"],
      }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/state/mailroom/registry.json": registryJson({
          sourceGrants: [
            { grantId: "g1", agentId: "test", ownerEmail: "x@y.com", source: "hey", aliasAddress: "x.test@ouro.bot", keyId: "k", publicKeyPem: "pem", defaultPlacement: "imbox", enabled: true },
          ],
        }),
      }),
    })
    const cat = checkMailroom(deps)
    expect(cat.checks[0].status).toBe("pass")
    expect(cat.checks[0].detail).toContain("1 mailbox")
    expect(cat.checks[0].detail).toContain("1 source grant")
    expect(cat.checks[0].detail).toContain("3 messages")
  })
})

// ── Friends checks ──

describe("checkFriends", () => {
  const friendJson = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
    id: "test-friend",
    name: "Test Friend",
    trustLevel: "friend",
    externalIds: [],
    ...overrides,
  })

  it("warns when no agents found", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles"]),
      readdirSync: readdirFor({ "/tmp/bundles": [] }),
    })
    const cat = checkFriends(deps)
    expect(cat.name).toBe("Friends")
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("no agent bundles")
  })

  it("passes when no friends directory (no friends recorded)", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
    })
    const cat = checkFriends(deps)
    expect(cat.checks[0].status).toBe("pass")
    expect(cat.checks[0].detail).toContain("no friends directory")
  })

  it("passes with zero count when friends dir is empty", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/test.ouro/friends"]),
      readdirSync: readdirFor({
        "/tmp/bundles": ["test.ouro"],
        "/tmp/bundles/test.ouro/friends": [],
      }),
    })
    const cat = checkFriends(deps)
    expect(cat.checks[0].status).toBe("pass")
    expect(cat.checks[0].detail).toBe("0 friends recorded")
  })

  it("passes with trust-level breakdown when friends are healthy", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/test.ouro/friends"]),
      readdirSync: readdirFor({
        "/tmp/bundles": ["test.ouro"],
        "/tmp/bundles/test.ouro/friends": ["a.json", "b.json", "c.json", "d.json", "ignore.txt"],
      }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/friends/a.json": friendJson({ id: "a", trustLevel: "family" }),
        "/tmp/bundles/test.ouro/friends/b.json": friendJson({ id: "b", trustLevel: "family" }),
        "/tmp/bundles/test.ouro/friends/c.json": friendJson({ id: "c", trustLevel: "friend" }),
        "/tmp/bundles/test.ouro/friends/d.json": friendJson({ id: "d", trustLevel: "stranger" }),
      }),
    })
    const cat = checkFriends(deps)
    expect(cat.checks[0].status).toBe("pass")
    expect(cat.checks[0].detail).toContain("4 friends")
    expect(cat.checks[0].detail).toContain("2 family")
    expect(cat.checks[0].detail).toContain("1 friend")
    expect(cat.checks[0].detail).toContain("1 stranger")
  })

  it("warns when some friend files are unparseable", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/test.ouro/friends"]),
      readdirSync: readdirFor({
        "/tmp/bundles": ["test.ouro"],
        "/tmp/bundles/test.ouro/friends": ["good.json", "bad.json"],
      }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/friends/good.json": friendJson(),
        "/tmp/bundles/test.ouro/friends/bad.json": "{not json",
      }),
    })
    const cat = checkFriends(deps)
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("1 unparseable")
  })

  it("counts a record with an unrecognized trust level under 'other'", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/test.ouro/friends"]),
      readdirSync: readdirFor({
        "/tmp/bundles": ["test.ouro"],
        "/tmp/bundles/test.ouro/friends": ["weird.json"],
      }),
      readFileSync: readFileFor({
        "/tmp/bundles/test.ouro/friends/weird.json": friendJson({ trustLevel: "blocked" }),
      }),
    })
    const cat = checkFriends(deps)
    expect(cat.checks[0].status).toBe("pass")
    expect(cat.checks[0].detail).toContain("1 other")
  })
})

// ── Disk checks ──

describe("checkLifecycle", () => {
  function ndjsonLine(ts: string, event: string, meta: Record<string, unknown> = {}): string {
    return JSON.stringify({ ts, level: "info", event, component: "daemon", message: "evt", meta }) + "\n"
  }

  it("warns when no daemon log is found", () => {
    const deps = createMockDeps({ existsSync: existsFor([]) })
    const cat = checkLifecycle(deps)
    expect(cat.name).toBe("Lifecycle")
    expect(cat.checks).toHaveLength(1)
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("no daemon.ndjson")
  })

  it("warns when an agent bundle exists but its daemon.ndjson does not", () => {
    // discoverAgents returns ['slugger.ouro'] (bundlesRoot exists), but the
    // log file inside it doesn't — the candidate-existsSync check fails.
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles"]), // bundlesRoot exists, log path doesn't
      readdirSync: readdirFor({ "/tmp/bundles": ["slugger.ouro"] }),
    })
    const cat = checkLifecycle(deps)
    expect(cat.checks[0].status).toBe("warn")
    expect(cat.checks[0].detail).toContain("no daemon.ndjson")
  })

  it("passes when last activity is recent", () => {
    const recentTs = new Date(Date.now() - 30_000).toISOString()
    const log = ndjsonLine(recentTs, "daemon.command_received")
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["slugger.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson": log }),
    })
    const cat = checkLifecycle(deps)
    const activity = cat.checks.find((c) => c.label === "recent daemon activity")
    expect(activity?.status).toBe("pass")
    expect(activity?.detail).toContain("daemon.command_received")
  })

  it("warns when last activity is older than 5 minutes", () => {
    const staleTs = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const log = ndjsonLine(staleTs, "senses.shared_turn_end")
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["slugger.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson": log }),
    })
    const cat = checkLifecycle(deps)
    const activity = cat.checks.find((c) => c.label === "recent daemon activity")
    expect(activity?.status).toBe("warn")
    expect(activity?.detail).toContain("silent or stopped")
  })

  it("counts daemon restarts in the last hour", () => {
    const now = Date.now()
    const log = [
      ndjsonLine(new Date(now - 30 * 60 * 1000).toISOString(), "daemon.daemon_started"),
      ndjsonLine(new Date(now - 20 * 60 * 1000).toISOString(), "daemon.daemon_started"),
      ndjsonLine(new Date(now - 60 * 1000).toISOString(), "daemon.command_received"),
    ].join("")
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["slugger.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson": log }),
    })
    const cat = checkLifecycle(deps)
    const restarts = cat.checks.find((c) => c.label === "daemon restarts (last hour)")
    expect(restarts?.status).toBe("pass")
    expect(restarts?.detail).toContain("2 restarts")
  })

  it("warns when restart count is high (churn)", () => {
    const now = Date.now()
    const lines: string[] = []
    for (let i = 0; i < 5; i++) {
      lines.push(ndjsonLine(new Date(now - (5 - i) * 60 * 1000).toISOString(), "daemon.daemon_started"))
    }
    lines.push(ndjsonLine(new Date(now - 1000).toISOString(), "daemon.command_received"))
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["slugger.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson": lines.join("") }),
    })
    const cat = checkLifecycle(deps)
    const restarts = cat.checks.find((c) => c.label === "daemon restarts (last hour)")
    expect(restarts?.status).toBe("warn")
    expect(restarts?.detail).toContain("high churn")
  })

  it("reports cli_version_install_end events with versions", () => {
    const now = Date.now()
    const log = [
      ndjsonLine(new Date(now - 10 * 60 * 1000).toISOString(), "daemon.cli_version_install_end", { version: "0.1.0-alpha.493" }),
      ndjsonLine(new Date(now - 1000).toISOString(), "daemon.command_received"),
    ].join("")
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["slugger.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson": log }),
    })
    const cat = checkLifecycle(deps)
    const installs = cat.checks.find((c) => c.label === "version installs (last hour)")
    expect(installs?.status).toBe("pass")
    expect(installs?.detail).toContain("alpha.493")
  })

  it("warns on agent_process_error events with the reason", () => {
    const now = Date.now()
    const log = [
      ndjsonLine(new Date(now - 5 * 60 * 1000).toISOString(), "daemon.agent_process_error", { agent: "slugger", reason: "ENOENT" }),
      ndjsonLine(new Date(now - 1000).toISOString(), "daemon.command_received"),
    ].join("")
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["slugger.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson": log }),
    })
    const cat = checkLifecycle(deps)
    const errors = cat.checks.find((c) => c.label === "agent process errors (last hour)")
    expect(errors?.status).toBe("warn")
    expect(errors?.detail).toContain("slugger: ENOENT")
  })

  it("ignores events older than one hour", () => {
    const oldTs = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const recentTs = new Date(Date.now() - 30_000).toISOString()
    const log = [
      ndjsonLine(oldTs, "daemon.daemon_started"),
      ndjsonLine(recentTs, "daemon.command_received"),
    ].join("")
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["slugger.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson": log }),
    })
    const cat = checkLifecycle(deps)
    const restarts = cat.checks.find((c) => c.label === "daemon restarts (last hour)")
    // Old daemon_started is outside the hour cutoff and not counted.
    expect(restarts).toBeUndefined()
  })

  it("handles malformed ndjson lines gracefully", () => {
    const recentTs = new Date(Date.now() - 1000).toISOString()
    const log = [
      "not valid json\n",
      JSON.stringify({ ts: "not a date", event: "wat" }) + "\n",
      ndjsonLine(recentTs, "daemon.command_received"),
    ].join("")
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["slugger.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson": log }),
    })
    const cat = checkLifecycle(deps)
    const activity = cat.checks.find((c) => c.label === "recent daemon activity")
    expect(activity?.status).toBe("pass")
    expect(activity?.detail).toContain("daemon.command_received")
  })

  it("fails if the log read throws", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["slugger.ouro"] }),
      readFileSync: () => { throw new Error("EACCES") },
    })
    const cat = checkLifecycle(deps)
    const readable = cat.checks.find((c) => c.label === "daemon log readable")
    expect(readable?.status).toBe("fail")
    expect(readable?.detail).toContain("EACCES")
  })

  it("falls back to 'unknown' when agent_process_error meta lacks reason/agent fields", () => {
    const recentTs = new Date(Date.now() - 1000).toISOString()
    const log = [
      ndjsonLine(recentTs, "daemon.agent_process_error", {}), // missing reason and agent
      ndjsonLine(recentTs, "daemon.command_received"),
    ].join("")
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["slugger.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson": log }),
    })
    const cat = checkLifecycle(deps)
    const errors = cat.checks.find((c) => c.label === "agent process errors (last hour)")
    expect(errors?.detail).toContain("unknown: unknown")
  })

  it("uses singular 'restart' when count is 1", () => {
    const now = Date.now()
    const log = [
      ndjsonLine(new Date(now - 30 * 60 * 1000).toISOString(), "daemon.daemon_started"),
      ndjsonLine(new Date(now - 1000).toISOString(), "daemon.command_received"),
    ].join("")
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["slugger.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson": log }),
    })
    const cat = checkLifecycle(deps)
    const restarts = cat.checks.find((c) => c.label === "daemon restarts (last hour)")
    expect(restarts?.detail).toContain("1 restart")
    expect(restarts?.detail).not.toContain("1 restarts")
  })

  it("truncates the agent_process_error detail when more than 3 errors", () => {
    const now = Date.now()
    const lines: string[] = []
    for (let i = 0; i < 5; i++) {
      lines.push(ndjsonLine(new Date(now - (5 - i) * 60 * 1000).toISOString(), "daemon.agent_process_error", { agent: `a${i}`, reason: `r${i}` }))
    }
    lines.push(ndjsonLine(new Date(now - 1000).toISOString(), "daemon.command_received"))
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["slugger.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson": lines.join("") }),
    })
    const cat = checkLifecycle(deps)
    const errors = cat.checks.find((c) => c.label === "agent process errors (last hour)")
    expect(errors?.detail).toContain("5 errors")
    expect(errors?.detail).toContain("...")
  })

  it("formats activity age in seconds when under one minute", () => {
    const log = ndjsonLine(new Date(Date.now() - 5_000).toISOString(), "daemon.command_received")
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["slugger.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson": log }),
    })
    const cat = checkLifecycle(deps)
    const activity = cat.checks.find((c) => c.label === "recent daemon activity")
    expect(activity?.detail).toMatch(/\d+s ago/)
  })

  it("trims to last 5000 lines when log is huge", () => {
    const lines: string[] = []
    // 10000 lines, the first 5000 should be ignored
    for (let i = 0; i < 5000; i++) {
      lines.push(ndjsonLine(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), "daemon.update_check"))
    }
    // Recent activity in last 5000 lines
    for (let i = 0; i < 5000; i++) {
      lines.push(ndjsonLine(new Date(Date.now() - 1000 - i).toISOString(), "daemon.command_received"))
    }
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["slugger.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson": lines.join("") }),
    })
    const cat = checkLifecycle(deps)
    const activity = cat.checks.find((c) => c.label === "recent daemon activity")
    expect(activity?.status).toBe("pass")
  })

  it("skips entries missing ts or event fields", () => {
    const recentTs = new Date(Date.now() - 1000).toISOString()
    const log = [
      JSON.stringify({ event: "daemon.daemon_started" }) + "\n", // no ts
      JSON.stringify({ ts: recentTs, message: "no event field" }) + "\n",
      JSON.stringify({ ts: "garbage-not-iso-date", event: "x" }) + "\n", // bad ts
      ndjsonLine(recentTs, "daemon.command_received"),
    ].join("")
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["slugger.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson": log }),
    })
    const cat = checkLifecycle(deps)
    const activity = cat.checks.find((c) => c.label === "recent daemon activity")
    expect(activity?.status).toBe("pass")
    expect(activity?.detail).toContain("daemon.command_received")
  })

  it("handles cli_version_install_end with no version meta", () => {
    const recentTs = new Date(Date.now() - 1000).toISOString()
    const log = [
      ndjsonLine(recentTs, "daemon.cli_version_install_end", {}), // no version key
      ndjsonLine(recentTs, "daemon.command_received"),
    ].join("")
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["slugger.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson": log }),
    })
    const cat = checkLifecycle(deps)
    const installs = cat.checks.find((c) => c.label === "version installs (last hour)")
    // installCount > 0 but no versions → detail says installed: (empty)
    expect(installs?.status).toBe("pass")
    expect(installs?.detail).toBe("installed: ")
  })

  it("warns when file exists but contains no parseable entries", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["slugger.ouro"] }),
      readFileSync: readFileFor({ "/tmp/bundles/slugger.ouro/state/daemon/logs/daemon.ndjson": "garbage\nnot json\n" }),
    })
    const cat = checkLifecycle(deps)
    const activity = cat.checks.find((c) => c.label === "recent daemon activity")
    expect(activity?.status).toBe("warn")
    expect(activity?.detail).toContain("no parseable events")
  })
})

describe("checkDisk", () => {
  it("passes when logs dir exists with reasonable size", () => {
    const logsDir = "/tmp/bundles/test.ouro/state/daemon/logs"
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", logsDir]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"], [logsDir]: ["daemon.log"] }),
      statSync: statFor({
        [`${logsDir}/daemon.log`]: { mode: 0o644, size: 5000 },
      }),
    })
    const cat = checkDisk(deps)
    expect(cat.name).toBe("Disk")
    expect(cat.checks.find((c) => c.label.includes("log size"))?.status).toBe("pass")
    expect(cat.checks.find((c) => c.label.includes("log size"))?.label).toBe("test.ouro daemon log size")
    expect(cat.checks.find((c) => c.label.includes("bundles root"))?.status).toBe("pass")
  })

  it("warns when log directory is missing", () => {
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles"]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"] }),
    })
    const cat = checkDisk(deps)
    expect(cat.checks.find((c) => c.label.includes("logs dir"))?.status).toBe("warn")
    expect(cat.checks.find((c) => c.label.includes("logs dir"))?.detail).toContain("/tmp/bundles/test.ouro/state/daemon/logs")
  })

  it("warns when log files are over 100MB", () => {
    const bigSize = 150 * 1024 * 1024 // 150MB
    const logsDir = "/tmp/bundles/test.ouro/state/daemon/logs"
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", logsDir]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"], [logsDir]: ["big.log"] }),
      statSync: statFor({
        [`${logsDir}/big.log`]: { mode: 0o644, size: bigSize },
      }),
    })
    const cat = checkDisk(deps)
    expect(cat.checks.find((c) => c.label.includes("log size"))?.status).toBe("warn")
    expect(cat.checks.find((c) => c.label.includes("log size"))?.detail).toContain("prune")
  })

  it("fails when log files are over 500MB", () => {
    const hugeSize = 600 * 1024 * 1024 // 600MB
    const logsDir = "/tmp/bundles/test.ouro/state/daemon/logs"
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", logsDir]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"], [logsDir]: ["huge.log"] }),
      statSync: statFor({
        [`${logsDir}/huge.log`]: { mode: 0o644, size: hugeSize },
      }),
    })
    const cat = checkDisk(deps)
    expect(cat.checks.find((c) => c.label.includes("log size"))?.status).toBe("fail")
    expect(cat.checks.find((c) => c.label.includes("log size"))?.detail).toContain("500MB")
  })

  it("warns when bundles root missing", () => {
    const deps = createMockDeps({
      existsSync: existsFor([]),
      readdirSync: readdirFor({}),
    })
    const cat = checkDisk(deps)
    expect(cat.checks.find((c) => c.label.includes("bundles root"))?.status).toBe("warn")
  })

  it("handles statSync failure on individual log files gracefully", () => {
    const logsDir = "/tmp/bundles/test.ouro/state/daemon/logs"
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", logsDir]),
      readdirSync: readdirFor({ "/tmp/bundles": ["test.ouro"], [logsDir]: ["bad.log"] }),
      statSync: vi.fn().mockImplementation(() => { throw new Error("EACCES") }),
    })
    const cat = checkDisk(deps)
    // Should still produce a result (0 bytes counted)
    expect(cat.checks.find((c) => c.label.includes("log size"))?.status).toBe("pass")
  })

  it("handles readdirSync failure on logs dir gracefully", () => {
    const logsDir = "/tmp/bundles/test.ouro/state/daemon/logs"
    const deps = createMockDeps({
      existsSync: existsFor(["/tmp/bundles", logsDir]),
      readdirSync: vi.fn().mockImplementation((path: string) => {
        if (path === "/tmp/bundles") return ["test.ouro"]
        throw new Error("EACCES")
      }),
    })
    const cat = checkDisk(deps)
    // Should still produce a result with 0 bytes (catch absorbs error)
    expect(cat.checks.find((c) => c.label.includes("log size"))?.status).toBe("pass")
  })
})
