import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { Server } from "node:net"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { auditSanctuaryContainerSpec } from "../../heart/daemon/container-spec-auditor"
import { createSanctuaryAcceptanceAdapterDependencies, readDefaultSanctuaryScenarioFacts } from "../../heart/daemon/sanctuary-acceptance-adapter"
import { validateSanctuaryUnit16EvidenceAssertions } from "../../heart/daemon/sanctuary-acceptance-harness"
import { deriveSanctuaryScenarioAssertions } from "../../heart/daemon/sanctuary-acceptance-scenarios"
import * as identity from "../../heart/identity"
import * as runtimeCredentials from "../../heart/runtime-credentials"
import { UnraidClient } from "../../repertoire/unraid-client"
import { resolveToolDefinition } from "../../repertoire/tools"
import { SANCTUARY_SYSTEM_QUERY } from "../../repertoire/tools-unraid"
import { sanctuaryTelegramAuditLifecycleMac } from "../../senses/telegram"
import { createTelegramAuditLedger, TELEGRAM_ACCEPTANCE_AUDIT_HEAD_RELATIVE_PATH, TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH } from "../../senses/telegram-audit-ledger"
import { sanctuaryContainerInspectFixture } from "../fixtures/sanctuary-container"
import { SANCTUARY_OWNER_ADDITIONS, sanctuaryContainmentBoundariesFixture } from "../fixtures/sanctuary-containment"

const state = vi.hoisted((): {
  root: string
  inspection: Record<string, unknown>
  servers: Server[]
  keyFds: Set<number>
  commands: Array<{ executable: string; args: readonly string[] }>
} => ({ root: "", inspection: {}, servers: [], keyFds: new Set(), commands: [] }))

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  const keyRoot = "/boot/config/plugins/dynamix.my.servers/keys"
  const mapped = (file: fs.PathLike): fs.PathLike => {
    if (file === "/proc/4242/status") return `${state.root}/proc-status`
    if (file === "/proc/4242/stat") return `${state.root}/proc-stat`
    if (file === "/proc/sys/kernel/random/boot_id") return `${state.root}/boot-id`
    if (file === "/var/lib/docker/unraid-autostart") return `${state.root}/autostart`
    if (file === keyRoot) return `${state.root}/keys`
    if (typeof file === "string" && file.startsWith(`${keyRoot}/`)) return `${state.root}/keys/${file.slice(keyRoot.length + 1)}`
    return file
  }
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(mapped(args[0]), args[1], args[2])
      if (typeof args[0] === "string" && args[0].startsWith(`${keyRoot}/`)) state.keyFds.add(fd)
      return fd
    },
    closeSync: (fd: number) => { state.keyFds.delete(fd); actual.closeSync(fd) },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
      if (state.keyFds.has(args[0])) return Object.assign(actual.fstatSync(args[0]), { uid: 0 })
      return actual.fstatSync(...args)
    },
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      if (args[0] === keyRoot) return Object.assign(actual.statSync(mapped(args[0])), { uid: 0 })
      return actual.statSync(...args)
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => actual.readdirSync(mapped(args[0]), args[1]),
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => actual.readFileSync(typeof args[0] === "number" ? args[0] : mapped(args[0]), args[1]),
    chownSync: (file: fs.PathLike, uid: number, gid: number) => {
      expect(String(file).startsWith(`${state.root}/`)).toBe(true)
      expect(uid).toBe(0)
      expect([0, 10001]).toContain(gid)
    },
  }
})

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>()
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args)
      state.servers.push(server)
      return server
    },
  }
})

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    spawnSync: (executable: string, args: readonly string[]) => {
      state.commands.push({ executable, args })
      let stdout: string
      if (executable === "/usr/bin/docker" && args[0] === "inspect") {
        const template = '{"containerId":{{json .Id}},"imageId":{{json .Image}},"running":{{json .State.Running}},"pid":{{json .State.Pid}},"startedAt":{{json .State.StartedAt}},"health":{{json .State.Health.Status}},"user":{{json .Config.User}},"readOnlyRoot":{{json .HostConfig.ReadonlyRootfs}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}},"networkMode":{{json .HostConfig.NetworkMode}},"restartPolicy":{{json .HostConfig.RestartPolicy.Name}},"restartCount":{{json .RestartCount}},"privileged":{{json .HostConfig.Privileged}},"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}}}'
        expect(args).toEqual(["inspect", "--format", template, "0".repeat(64)])
        stdout = JSON.stringify(state.inspection)
      } else if (executable === "/usr/bin/docker" && args[0] === "exec") {
        expect(args).toEqual(["exec", "0".repeat(64), "node", "/opt/ouro/dist/heart/daemon/ouro-entry.js", "vault", "status", "--agent", "sanctuary", "--store", "plaintext-file"])
        stdout = ""
      } else if (executable === "/usr/bin/docker" && args[0] === "run") {
        expect(args).toEqual(["run", "--rm", "--pull=never", "--network", "none", "--entrypoint", "/bin/cat", state.inspection.imageId, "/opt/ouro/container-runtime.json"])
        stdout = '{"scheduler":"supercronic","updates":"disabled"}'
      } else if (executable === "/usr/local/sbin/mdcmd") {
        expect(args).toEqual(["status"])
        stdout = "mdState=STARTED\n"
      } else if (executable === "/usr/local/sbin/tailscale") {
        expect(args).toEqual(["status", "--json"])
        stdout = '{"BackendState":"Running"}'
      } else if (executable === "/usr/bin/pgrep") {
        expect(args).toEqual(["-x", "sshd"])
        stdout = "4243\n"
      } else {
        throw new Error(`unexpected host command: ${executable} ${args.join(" ")}`)
      }
      return { status: 0, stdout, stderr: "", signal: null, pid: 4244, output: [null, stdout, ""] }
    },
  }
})

const readPermissions = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
  .map((resource) => ({ resource, actions: ["READ_ANY"] }))
let spec: ReturnType<typeof sanctuaryContainerInspectFixture>
let originalArgv: string[]
let originalExitCode: typeof process.exitCode
const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"]
let originalSignals = new Map(signals.map((signal) => [signal, new Set(process.listeners(signal))]))
let instance = 0

beforeEach(() => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), "u16-"))
  state.servers = []
  state.commands = []
  state.keyFds.clear()
  originalArgv = process.argv
  originalExitCode = process.exitCode
  originalSignals = new Map(signals.map((signal) => [signal, new Set(process.listeners(signal))]))
  spec = sanctuaryContainerInspectFixture()
  state.inspection = {
    containerId: "0".repeat(64), imageId: spec.Image, running: true, pid: 4242,
    startedAt: "2026-09-10T00:00:00.000Z", health: "healthy", user: spec.Config.User,
    readOnlyRoot: spec.HostConfig.ReadonlyRootfs,
    mounts: spec.Mounts.map((mount) => ({ ...mount, Mode: "" })),
    ports: spec.NetworkSettings.Ports, networkMode: spec.HostConfig.NetworkMode,
    restartPolicy: spec.HostConfig.RestartPolicy.Name, restartCount: 0,
    privileged: spec.HostConfig.Privileged, capAdd: spec.HostConfig.CapAdd,
    capDrop: spec.HostConfig.CapDrop, securityOpt: spec.HostConfig.SecurityOpt,
  }
  fs.mkdirSync(path.join(state.root, "keys"), { mode: 0o700 })
  for (const [file, record] of [
    ["ro.json", { id: "ro-fixture", name: "Butler RO", key: "fixture-read-key", permissions: readPermissions, roles: [] }],
    ["rw.json", { id: "rw-fixture", name: "Butler RW", key: "fixture-write-key", permissions: [...readPermissions, { resource: "DOCKER", actions: ["UPDATE_ANY"] }], roles: [] }],
  ] as const) fs.writeFileSync(path.join(state.root, "keys", file), JSON.stringify(record), { mode: 0o600 })
  fs.writeFileSync(path.join(state.root, "proc-status"), "Name:\tnode\nUid:\t10001\t10001\t10001\t10001\nGid:\t10001\t10001\t10001\t10001\n")
  fs.writeFileSync(path.join(state.root, "proc-stat"), `4242 (node) S ${Array(18).fill("0").join(" ")} 9001\n`)
  fs.writeFileSync(path.join(state.root, "boot-id"), "fixture-boot-id\n")
  fs.writeFileSync(path.join(state.root, "autostart"), "")
})

afterEach(async () => {
  for (const server of state.servers) {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
  for (const [signal, previous] of originalSignals) {
    for (const listener of process.listeners(signal)) if (!previous.has(listener)) process.removeListener(signal, listener)
  }
  process.argv = originalArgv
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
  expect(state.keyFds.size).toBe(0)
  fs.rmSync(state.root, { recursive: true, force: true })
})

async function launchBroker() {
  const file = path.resolve("deploy/unraid/sanctuary-unit16-host-broker.mjs")
  const getuid = vi.spyOn(process, "getuid").mockReturnValue(0)
  process.exitCode = undefined
  process.argv = ["node", file, "final", "0".repeat(64), path.join(state.root, "s.sock"), path.join(state.root, "inventory.json"), spec.Image, path.join(state.root, "initial.json")]
  try {
    await import(`${pathToFileURL(file).href}?physical=${++instance}`)
  } finally {
    getuid.mockRestore()
    process.argv = originalArgv
  }
  await vi.waitFor(() => {
    expect(process.exitCode === 1 || state.servers.some((server) => server.listening)).toBe(true)
  })
  return createSanctuaryAcceptanceAdapterDependencies(3, {
    hostBrokerSocket: path.join(state.root, "s.sock"),
    scenarioCapture: { agentRoot: path.join(state.root, "agent") },
  })
}

const emptyRepresentations: Array<string[] | null> = [null, []]
const securityRepresentations = emptyRepresentations.flatMap((capAdd) => emptyRepresentations.flatMap((capDrop) => emptyRepresentations.map((securityOpt) => ({ capAdd, capDrop, securityOpt }))))

describe("native Sanctuary physical evidence producer", () => {
  it.each(securityRepresentations)("matches canonical A-002 with native empty Mode: %j", async (security) => {
    Object.assign(state.inspection, security)
    Object.assign(spec.HostConfig, { CapAdd: security.capAdd, CapDrop: security.capDrop, SecurityOpt: security.securityOpt })
    expect(auditSanctuaryContainerSpec(spec, {
      expectedImage: spec.Image, expectedEnvironment: spec.Config.Env,
      expectedImageReference: spec.Config.Image, expectedIcon: spec.Config.Labels["net.unraid.docker.icon"],
    })).toEqual({ ok: true, violations: [] })
    const dependencies = await launchBroker()
    expect(process.exitCode).not.toBe(1)
    const snapshot = await dependencies.hostRequest!({ operation: "container_snapshot", targetId: "sanctuary" })
    expect(snapshot).toMatchObject({
      containerId: "0".repeat(64), imageId: spec.Image, user: "10001:10001", liveProcessUser: "10001:10001",
      mountCount: 3, readOnlyRoot: false, mountsExact: true, securityExact: true,
      publishedPortCount: 0, networkMode: "host", updaterDisabled: true, writableKeyExposure: false,
    })
  })

  it.each([undefined, null, 0, "false", [], {}].map((readOnlyRoot) => ({ readOnlyRoot })))("fails before a receipt for non-boolean root mode $readOnlyRoot", async ({ readOnlyRoot }) => {
    state.inspection.readOnlyRoot = readOnlyRoot
    await launchBroker()
    expect(process.exitCode).toBe(1)
    expect(fs.existsSync(path.join(state.root, "initial.json"))).toBe(false)
    expect(state.servers).toHaveLength(0)
  })

  it.each(["capAdd", "capDrop", "securityOpt"].flatMap((field) => [
    undefined, false, 0, "not-an-array", {}, [field === "securityOpt" ? "no-new-privileges" : "ALL"],
  ].map((value) => ({ field, value }))))("rejects noncanonical $field = $value after a passing control", async ({ field, value }) => {
    const dependencies = await launchBroker()
    const request = { operation: "container_snapshot", targetId: "sanctuary" }
    expect(await dependencies.hostRequest!(request)).toMatchObject({ mountsExact: true, securityExact: true })
    state.inspection[field] = value
    expect(await dependencies.hostRequest!(request)).toMatchObject({ mountsExact: true, securityExact: false })
  })

  it.each([true, undefined, null, 0, "false"].map((privileged) => ({ privileged })))("rejects noncanonical privileged = $privileged after a passing control", async ({ privileged }) => {
    const dependencies = await launchBroker()
    const request = { operation: "container_snapshot", targetId: "sanctuary" }
    expect(await dependencies.hostRequest!(request)).toMatchObject({ securityExact: true })
    state.inspection.privileged = privileged
    expect(await dependencies.hostRequest!(request)).toMatchObject({ securityExact: false })
  })

  it.each([
    { field: "Source", value: "/other/spool" },
    { field: "Destination", value: "/other/events" },
    { field: "RW", value: true },
    { field: "RW", value: undefined },
    { field: "RW", value: "false" },
    { field: "Type", value: "volume" },
    { field: "Propagation", value: "rshared" },
  ])("rejects changed event-spool $field = $value after a passing control", async ({ field, value }) => {
    const dependencies = await launchBroker()
    const request = { operation: "container_snapshot", targetId: "sanctuary" }
    expect(await dependencies.hostRequest!(request)).toMatchObject({ mountsExact: true, mountCount: 3 })
    const mounts = spec.Mounts.map((mount) => ({ ...mount, Mode: "" }))
    Object.assign(mounts[2]!, { [field]: value })
    state.inspection.mounts = mounts
    expect(await dependencies.hostRequest!(request)).toMatchObject({ mountsExact: false, mountCount: 3 })
  })

  it.each([true, false])("rejects a Docker socket with extra-mount=%s", async (extra) => {
    const dependencies = await launchBroker()
    const request = { operation: "container_snapshot", targetId: "sanctuary" }
    expect(await dependencies.hostRequest!(request)).toMatchObject({ mountsExact: true, writableKeyExposure: false })
    const mounts = spec.Mounts.map((mount) => ({ ...mount, Mode: "" }))
    const socket = { ...mounts[2]!, Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: true }
    state.inspection.mounts = extra ? [...mounts, socket] : [...mounts.slice(0, 2), socket]
    expect(await dependencies.hostRequest!(request)).toMatchObject({ mountsExact: false, mountCount: extra ? 4 : 3, writableKeyExposure: true })
  })

  it("records advisory Mode changes without substituting them for actual RW", async () => {
    const dependencies = await launchBroker()
    const request = { operation: "container_snapshot", targetId: "sanctuary" }
    const before = await dependencies.hostRequest!(request)
    expect(before).toMatchObject({ mountsExact: true })
    state.inspection.mounts = spec.Mounts.map((mount) => ({ ...mount, Mode: mount.RW ? "ro" : "rw" }))
    const after = await dependencies.hostRequest!(request)
    expect(after).toMatchObject({ mountsExact: true, mountCount: 3 })
    expect(after).not.toEqual(before)
  })

  it("returns the existing socket error instead of a receipt when root evidence becomes invalid", async () => {
    const dependencies = await launchBroker()
    const request = { operation: "container_snapshot", targetId: "sanctuary" }
    expect(await dependencies.hostRequest!(request)).toMatchObject({ readOnlyRoot: false, securityExact: true })
    delete state.inspection.readOnlyRoot
    await expect(dependencies.hostRequest!(request)).rejects.toThrow("Sanctuary host acceptance operation failed")
  })

  it("feeds the actual broker through the adapter, role dispatch, scenario and final v2 validator", async () => {
    const dependencies = await launchBroker()
    const agentRoot = path.join(state.root, "agent")
    const identityKey = "k".repeat(43)
    const handle = "a".repeat(64)
    const label = "unit-16e-containment-audit"
    const ledger = createTelegramAuditLedger({ root: agentRoot, identityKey })
    for (const [event, ts, meta] of [
      ["senses.telegram_turn_start", "2026-09-10T00:00:00.000Z", { scenarioHandleDigest: handle }],
      ["senses.telegram_turn_end", "2026-09-10T00:00:01.000Z", { scenarioHandleDigest: handle, deliveryCount: 1 }],
    ] as const) {
      ledger.append({
        ts, event, level: "info", component: "senses", trace_id: "fixture", message: "fixture",
        meta: { ...meta, lifecycleMac: sanctuaryTelegramAuditLifecycleMac(identityKey, "sanctuary-telegram-turn-receipt-v3", event, meta) },
      })
    }
    fs.copyFileSync("deploy/unraid/sanctuary.ouro/tool-profiles.json", path.join(agentRoot, "tool-profiles.json"))
    const files: Record<string, string> = {
      [path.join("/home/ouro/AgentBundles/sanctuary.ouro", TELEGRAM_ACCEPTANCE_AUDIT_RELATIVE_PATH)]: fs.readFileSync(ledger.ledgerPath, "utf8"),
      [path.join("/home/ouro/AgentBundles/sanctuary.ouro", TELEGRAM_ACCEPTANCE_AUDIT_HEAD_RELATIVE_PATH)]: fs.readFileSync(ledger.headPath, "utf8"),
      [path.join(agentRoot, "state/senses/telegram/identity.key")]: `${identityKey}\n`,
    }
    dependencies.readFixedFile = (file) => {
      if (file in files) return files[file]!
      throw Object.assign(new Error(`absent fixture file: ${file}`), { code: "ENOENT" })
    }
    dependencies.telegramCredentials = () => ({ botToken: "123:token", authorizedUserId: "123456789", authorizedChatId: "987654321" })
    dependencies.providerRuntime = async () => ({
      id: "minimax", model: "fixture", client: null, capabilities: new Set(["reasoning-effort"]),
      streamTurn: async () => { throw new Error("the physical audit must not request a live model turn") },
      appendToolOutput: () => undefined, resetTurnState: () => undefined, ping: async () => undefined, classifyError: () => "unknown",
    })
    vi.spyOn(identity, "getAgentRoot").mockReturnValue(agentRoot)
    vi.spyOn(identity, "getAgentName").mockReturnValue("sanctuary")
    vi.spyOn(identity, "loadAgentConfig").mockReturnValue({
      version: 1, enabled: true, phrases: { thinking: [], tool: [], followup: [] },
      humanFacing: { provider: "minimax", model: "MiniMax-M3" }, agentFacing: { provider: "minimax", model: "MiniMax-M3" },
    })
    vi.spyOn(runtimeCredentials, "readMachineRuntimeCredentialConfig").mockReturnValue({
      ok: true, itemPath: "vault:fixture", revision: "fixture", updatedAt: "2026-09-10T00:00:00.000Z",
      config: { unraidGraphqlUrl: "https://sanctuary.invalid/graphql", unraidReadApiKey: "synthetic-read-key" },
    })
    const read = vi.spyOn(UnraidClient.prototype, "read").mockResolvedValue({
      vars: { id: `${"a".repeat(64)}:vars`, name: "Sanctuary", version: "7.2.3" },
      info: { time: "2026-09-10T00:00:00.000Z", os: { uptime: 10 }, versions: { core: { unraid: "7.2.3", api: "4.37.1" } } },
      array: { state: "STARTED" },
    })
    const effects = [...SANCTUARY_OWNER_ADDITIONS, "credential_get"].map((name) => vi.spyOn(resolveToolDefinition(name)!, "handler").mockImplementation(async () => {
      throw new Error(`the physical audit must not invoke ${name}`)
    }))
    const facts = await readDefaultSanctuaryScenarioFacts(label, handle, dependencies, agentRoot)
    expect(facts.containment?.profileBoundaries).toEqual(sanctuaryContainmentBoundariesFixture(["reasoning-effort"]))
    expect(read).toHaveBeenCalledTimes(3)
    for (const call of read.mock.calls) expect(call).toEqual([SANCTUARY_SYSTEM_QUERY, {}])
    for (const effect of effects) expect(effect).not.toHaveBeenCalled()
    const now = Date.parse("2026-09-10T00:00:02.000Z")
    const assertions = deriveSanctuaryScenarioAssertions(label, facts, facts, now, handle)
    expect(assertions).not.toBeNull()
    expect(validateSanctuaryUnit16EvidenceAssertions(label, assertions)).toMatchObject({ mountCount: 3, readOnlyRoot: false, mountsExact: true, securityExact: true })
    state.inspection.readOnlyRoot = true
    const noncanonical = await readDefaultSanctuaryScenarioFacts(label, handle, dependencies, agentRoot)
    expect(noncanonical.containment?.readOnlyRoot).toBe(true)
    expect(deriveSanctuaryScenarioAssertions(label, facts, noncanonical, now, handle)).toBeNull()
    expect(() => validateSanctuaryUnit16EvidenceAssertions(label, { ...assertions, readOnlyRoot: true })).toThrow("readOnlyRoot must be false")
  })
})
