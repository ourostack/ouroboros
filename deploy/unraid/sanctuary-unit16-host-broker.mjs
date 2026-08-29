#!/usr/local/bin/node

import { spawn, spawnSync } from "node:child_process"
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { chmodSync, chownSync, closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, opendirSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { targetProfile } from "./sanctuary-deployment-target.mjs"

const KEY_ROOT = "/boot/config/plugins/dynamix.my.servers/keys"
const RECOVERY_ROOT = "/mnt/user/appdata/ouro-butler/acceptance/revoked-key-proof"
const UNRAID_API = "/usr/local/sbin/unraid-api"
const DOCKER = "/usr/bin/docker"
let activeContainer = "ouro-butler"
let activeContainerId = "0".repeat(64)
let activeProfile = targetProfile("final")
const AUTOSTART_FILE = "/var/lib/docker/unraid-autostart"
const RUNTIME_POLICY_FILE = "/opt/ouro/container-runtime.json"
const PRODUCTION_RUNTIME_SOURCE = "/mnt/user/appdata/ouro-butler/runtime/.ouro-cli"
const PRODUCTION_BUNDLE_SOURCE = "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro"
const PRODUCTION_EVENT_SPOOL_SOURCE = "/boot/config/custom/ouro-events/spool"
const PRODUCTION_SAB_CONFIG_SOURCE = "/mnt/user/appdata/sabnzbd/sabnzbd.ini"
const GRAPHQL_ENDPOINT = "http://127.0.0.1/graphql"
const BOOT_ID = "/proc/sys/kernel/random/boot_id"
const MDCMD = "/usr/local/sbin/mdcmd"
const TAILSCALE = "/usr/local/sbin/tailscale"
const PGREP = "/usr/bin/pgrep"
const REBOOT = "/sbin/reboot"
const TARGET_SERVER = "sanctuary-unraid"
const TARGET_HOST = "sanctuary"
const KEY_ID = /^[A-Za-z0-9._:-]+$/u
const KEY_NAME = /^Butler (?:RO|RW)(?: Rotation [0-9a-f]{16})?$/u
const PERMISSION = /^[A-Z_]+:(?:CREATE|READ|UPDATE|DELETE)_(?:ANY|OWN)$/u
const MAX_REQUEST = 256 * 1024
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const HEALTH_PROBE_ENTRY = "/opt/ouro/dist/senses/sanctuary-health-acceptance-probe-entry.js"
const ACCEPTANCE_ADAPTER = "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh"
const HEALTH_PROBE_TERM_GRACE_MS = 5_000
const HEALTH_PROBE_KILL_GRACE_MS = 5_000
const HEALTH_PROBE_LABELS = new Set(["unit-16f-cron-fingerprint", "unit-16g-health-transition", "unit-16h-daily-digest"])
const ASYNC_RESTART_SCENARIO = Symbol("asyncRestartScenario")
const HEALTH_PROBE_RECEIPT_KEYS = [
  "schemaVersion", "label", "scenarioHandleDigest", "ownerImageDigestBefore", "ownerImageDigestAfter",
  "ownerContainerDigestBefore", "ownerContainerDigestAfter", "beforeStateDigest", "restoredStateDigest",
  "cronFingerprintBefore", "cronFingerprintAfter", "cronRegisteredBefore", "cronRegisteredAfter",
  "cronDegradedBefore", "cronDegradedAfter", "fixtureSequenceDigest", "clockMode", "effectiveNow", "phases",
  "providerInvocationCount", "privateTurnCount", "deliveryCount", "workspaceAbsent", "socketAbsent",
  "snapshotAbsent", "realCheckEquivalent", "productionRestored", "schedulerReceipt",
]
const RO_PERMISSIONS = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
  .map((resource) => `${resource}:READ_ANY`).sort()
let expectedImageId = ""
const activeHealthProbes = new Map()
const ownerMutationCoordinator = createOwnerMutationCoordinator()
const interactiveRestartDriver = createInteractiveRestartDriver()
const healthProbeCoordinator = {
  start: (scenario, operation) => ownerMutationCoordinator.healthStart(scenario, operation),
  recover: (scenario, operation) => ownerMutationCoordinator.healthRecover(scenario, operation),
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function text(value, label, pattern) {
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) throw new Error(`${label} is invalid`)
  return value
}

function exactKeys(value, expected, label) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) throw new Error(`${label} shape is invalid`)
}

function observeRebootPreflight(dependencies = {
  readArrayStatus: () => {
    const result = spawnSync(MDCMD, ["status"], { cwd: "/", encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "pipe", "ignore"] })
    if (result.error || result.status !== 0) throw new Error("reboot preflight array state is unknown")
    return result.stdout
  },
  readMoverStatus: () => spawnSync(PGREP, ["-x", "mover"], { cwd: "/", encoding: "utf8", timeout: 5_000, env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "ignore", "ignore"] }),
  mutationActive: () => healthOwnerMutationActive() || ownerMutationCoordinator.active(),
}) {
  const values = Object.fromEntries(String(dependencies.readArrayStatus()).split(/\r?\n/u).filter(Boolean).map((line) => {
    const separator = line.indexOf("=")
    if (separator < 1) throw new Error("reboot preflight array state is unknown")
    return [line.slice(0, separator), line.slice(separator + 1)]
  }))
  if (values.mdState !== "STARTED" || !/^[0-9]+$/u.test(values.mdResync ?? "")) throw new Error("reboot preflight array state is unknown")
  const mover = dependencies.readMoverStatus()
  if (mover.error || (mover.status !== 0 && mover.status !== 1)) throw new Error("reboot preflight mover state is unknown")
  const state = { arrayReady: true, parityActive: Number(values.mdResync) !== 0, moverActive: mover.status === 0, mutationActive: dependencies.mutationActive() === true }
  if (state.parityActive || state.moverActive || state.mutationActive) throw new Error("reboot preflight found an active host operation")
  const digest = createHash("sha256").update(JSON.stringify(state)).digest("hex")
  return { ...state, safe: true, digest }
}

function readPrivateJson(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = fstatSync(fd)
    if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o777) !== 0o600) throw new Error("Unraid key file metadata is invalid")
    return object(JSON.parse(readFileSync(fd, "utf8")), "Unraid key record")
  } finally { closeSync(fd) }
}

function normalizeRecord(raw) {
  const id = text(raw.id, "key id", KEY_ID)
  const name = text(raw.name, "key name")
  if (!Array.isArray(raw.permissions) || !Array.isArray(raw.roles)) throw new Error("Unraid key record is invalid")
  const permissions = raw.permissions.map((entry) => {
    const value = object(entry, "permission")
    exactKeys(value, ["resource", "actions"], "permission")
    const resource = text(value.resource, "permission resource", /^[A-Z_]+$/u)
    if (!Array.isArray(value.actions) || value.actions.length === 0) throw new Error("permission actions are invalid")
    const actions = value.actions.map((action) => text(action, "permission action", /^(?:CREATE|READ|UPDATE|DELETE)_(?:ANY|OWN)$/u)).sort()
    if (new Set(actions).size !== actions.length) throw new Error("permission actions are ambiguous")
    return { resource, actions }
  })
  if (!raw.roles.every((role) => typeof role === "string")) throw new Error("Unraid key roles are invalid")
  return { id, name, permissions, roles: [...raw.roles], key: text(raw.key, "key descriptor") }
}

function inventoryRecords() {
  const root = statSync(KEY_ROOT)
  if (!root.isDirectory() || root.uid !== 0 || (root.mode & 0o077) !== 0) throw new Error("Unraid key directory metadata is invalid")
  const records = readdirSync(KEY_ROOT, { withFileTypes: true }).map((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".json")) throw new Error("unexpected Unraid key directory entry")
    return normalizeRecord(readPrivateJson(`${KEY_ROOT}/${entry.name}`))
  })
  if (new Set(records.map(({ id }) => id)).size !== records.length || new Set(records.map(({ name }) => name)).size !== records.length) {
    throw new Error("Unraid key inventory is ambiguous")
  }
  return records.sort((left, right) => left.id.localeCompare(right.id))
}

function publicRecord({ key: _key, ...record }) { return record }

function flattened(record) {
  return record.permissions.flatMap(({ resource, actions }) => actions.map((action) => `${resource}:${action}`)).sort()
}

function runUnraid(args) {
  const result = spawnSync(UNRAID_API, args, {
    cwd: "/", encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" },
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.error || result.status !== 0) throw new Error("bounded Unraid API operation failed")
  return object(JSON.parse(result.stdout), "Unraid API response")
}

function autostartFileExact() {
  const fd = openSync(AUTOSTART_FILE, constants.O_RDONLY | constants.O_NOFOLLOW)
  let content
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Unraid autostart state is invalid")
    content = readFileSync(fd, "utf8")
  } finally { closeSync(fd) }
  const counts = { production: 0, staging: 0, rollback: 0, legacy: 0 }
  for (const line of content.split(/\r?\n/u)) {
    const name = line.trim().split(/\s+/u)[0]
    if (name === "ouro-butler") counts.production += 1
    else if (name === "ouro-butler-staging") counts.staging += 1
    else if (name === "ouro-butler-rollback") counts.rollback += 1
    else if (name === "ouro-butler-legacy-evidence") counts.legacy += 1
  }
  return activeProfile.name === "staging"
    ? counts.production === 0 && counts.staging === 1 && counts.rollback === 0 && counts.legacy === 0
    : counts.production === 1 && counts.staging === 0 && counts.rollback === 0 && counts.legacy === 0
}

function optionalStoppedContainerExact(name, containerId, run = spawnSync) {
  if (name !== "ouro-butler-rollback" || !SHA256.test(containerId)) return false
  const template = '{"containerId":{{json .Id}},"name":{{json .Name}},"running":{{json .State.Running}}}'
  const result = run(DOCKER, ["inspect", "--format", template, containerId], {
    cwd: "/", encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024,
    env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.error || result.status !== 0) return false
  try {
    const value = object(JSON.parse(result.stdout ?? ""), "optional rollback inspection")
    return value.containerId === containerId && value.name === `/${name}` && value.running === false
  } catch { return false }
}

async function queryGraphqlAutostart(records = inventoryRecords(), fetchImpl = fetch, expectedContainerId = activeContainerId, profile = activeProfile, inspectOptionalStopped = optionalStoppedContainerExact) {
  text(expectedContainerId, "attested target container id", SHA256)
  const matches = records.filter((record) => record.name === "Butler RO" && record.roles.length === 0
    && JSON.stringify(flattened(record)) === JSON.stringify(RO_PERMISSIONS))
  if (matches.length !== 1) throw new Error("canonical read-only Unraid key is absent or ambiguous")
  const descriptor = text(matches[0].key, "canonical read-only key descriptor")
  const response = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": descriptor },
    body: JSON.stringify({ query: "query AcceptanceContainerTopology { vars { id } docker { containers(skipCache: true) { id names autoStart } } }", variables: {} }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error("Unraid container topology query failed")
  const envelope = object(await response.json(), "Unraid container topology response")
  if (envelope.errors || !envelope.data) throw new Error("Unraid container topology query was rejected")
  const data = object(envelope.data, "Unraid topology data")
  const serverIdentity = /^([0-9a-f]{64}):vars$/u.exec(object(data.vars, "Unraid topology vars").id)
  if (!serverIdentity) throw new Error("Unraid server identity is invalid")
  const containers = object(data.docker, "Unraid topology docker").containers
  if (!Array.isArray(containers)) throw new Error("Unraid container topology is invalid")
  const canonicalNames = new Set(["ouro-butler", "ouro-butler-staging", "ouro-butler-rollback"])
  const topology = new Map()
  for (const raw of containers) {
    const container = object(raw, "Unraid topology container")
    if (!Array.isArray(container.names) || container.names.some((name) => typeof name !== "string")) throw new Error("Unraid container topology identity is invalid")
    const canonical = container.names.map((name) => name.replace(/^\//u, "")).filter((name) => canonicalNames.has(name))
    if (canonical.length > 1) return false
    if (canonical.length === 0) continue
    const identity = typeof container.id === "string" ? /^([0-9a-f]{64}):([0-9a-f]{64})$/u.exec(container.id) : null
    if (!identity || identity[1] !== serverIdentity[1] || typeof container.autoStart !== "boolean" || topology.has(canonical[0])) return false
    topology.set(canonical[0], { containerId: identity[2], autoStart: container.autoStart })
  }
  const requiredNames = new Set([profile.containerName, ...profile.requiredStopped])
  const allowedNames = new Set([...requiredNames, ...profile.optionalStopped])
  if ([...requiredNames].some((name) => !topology.has(name)) || [...topology.keys()].some((name) => !allowedNames.has(name))
    || profile.forbidden.some((name) => topology.has(name))) return false
  const target = topology.get(profile.containerName)
  if (!target || target.containerId !== expectedContainerId || target.autoStart !== true) return false
  return [...profile.requiredStopped, ...profile.optionalStopped].every((name) => {
    const stopped = topology.get(name)
    return !stopped || (stopped.autoStart === false && inspectOptionalStopped(name, stopped.containerId))
  })
}

function updaterDisabled(expectedImage) {
  const result = spawnSync(DOCKER, ["run", "--rm", "--pull=never", "--network", "none", "--entrypoint", "/bin/cat", expectedImage, RUNTIME_POLICY_FILE], {
    cwd: "/", encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024,
    env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.error || result.status !== 0) throw new Error("container runtime policy read failed")
  const policy = object(JSON.parse(result.stdout), "container runtime policy")
  exactKeys(policy, ["scheduler", "updates"], "container runtime policy")
  return policy.scheduler === "supercronic" && policy.updates === "disabled"
}

function parseVaultStatus(output, succeeded) {
  const lines = output.split(/\r?\n/u)
  const runtimeLine = lines.find((line) => line.startsWith("runtime credentials: "))
  const runtimeMatch = /^runtime credentials: (.+) \([^)]+\)$/u.exec(runtimeLine ?? "")
  const runtimeFields = runtimeMatch ? runtimeMatch[1].split(", ") : []
  const providerReady = (provider) => {
    const line = lines.find((candidate) => candidate.startsWith(`  ${provider}: `))
    const match = /^  [a-z0-9-]+: credential fields (.+), config fields (.+)$/u.exec(line ?? "")
    if (!match) return false
    return match[1].split(", ").includes("apiKey") && match[2].split(", ").includes("baseUrl")
  }
  const unlocked = succeeded && /^local unlock: available$/mu.test(output)
    && ["telegramBotToken", "telegramAuthorizedUserId", "telegramAuthorizedChatId"].every((field) => runtimeFields.includes(field))
    && providerReady("openai-compatible") && providerReady("openai-compatible-gemini")
  return { vaultUnlocked: unlocked, manualAuthRequired: !unlocked }
}

function vaultStatus(running, healthy) {
  if (!running || !healthy) return { vaultUnlocked: false, manualAuthRequired: true }
  const result = spawnSync(DOCKER, ["exec", activeContainerId, "node", "/opt/ouro/dist/heart/daemon/ouro-entry.js", "vault", "status", "--agent", "sanctuary", "--store", "plaintext-file"], {
    cwd: "/", encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "pipe", "ignore"],
  })
  return parseVaultStatus(result.stdout ?? "", !result.error && result.status === 0)
}

function recoveryMilestones(running, healthy) {
  const array = spawnSync(MDCMD, ["status"], { cwd: "/", encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] })
  const tailscale = spawnSync(TAILSCALE, ["status", "--json"], { cwd: "/", encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] })
  const ssh = spawnSync(PGREP, ["-x", "sshd"], { cwd: "/", encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] })
  let tailscaleReady = false
  try {
    const status = object(JSON.parse(tailscale.stdout), "Tailscale status")
    tailscaleReady = !tailscale.error && tailscale.status === 0 && status.BackendState === "Running"
  } catch { tailscaleReady = false }
  return {
    hostReady: /^[A-Za-z0-9-]{4,128}$/u.test(readFileSync(BOOT_ID, "utf8").trim()),
    arrayReady: !array.error && array.status === 0 && /^mdState=STARTED$/mu.test(array.stdout),
    dockerReady: true,
    butlerReady: running && healthy,
    tailscaleReady,
    sshReady: !ssh.error && ssh.status === 0 && ssh.stdout.trim().length > 0,
  }
}

function readBoundedProcStatus(statusPath) {
  const fd = openSync(statusPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = fstatSync(fd)
    if (!metadata.isFile()) throw new Error("container PID1 status is invalid")
    const buffer = Buffer.alloc(128 * 1024 + 1)
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    if (length > 128 * 1024) throw new Error("container PID1 status exceeds its bound")
    return buffer.subarray(0, length).toString("utf8")
  } finally { closeSync(fd) }
}

function readBoundedProcIdentityFile(filePath) {
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = fstatSync(fd, { bigint: true })
    if (!metadata.isFile()) throw new Error("container PID1 process file is invalid")
    const buffer = Buffer.alloc(128 * 1024 + 1)
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    if (length > 128 * 1024) throw new Error("container PID1 process file exceeds its bound")
    return { content: buffer.subarray(0, length).toString("utf8"), inode: metadata.ino.toString() }
  } finally { closeSync(fd) }
}

function parseProcStartTime(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 128 * 1024) throw new Error("container PID1 stat is invalid")
  const close = raw.lastIndexOf(")")
  if (close < 3) throw new Error("container PID1 stat is invalid")
  const fields = raw.slice(close + 1).trim().split(/\s+/u)
  const startTime = fields[19]
  if (!startTime || !/^[0-9]+$/u.test(startTime)) throw new Error("container PID1 stat start time is invalid")
  return startTime
}

function liveContainerProcessIdentity(pid, dependencies = { readFile: readBoundedProcIdentityFile }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 4_194_304) throw new Error("container PID1 is invalid")
  const status = dependencies.readFile(`/proc/${pid}/status`)
  const stat = dependencies.readFile(`/proc/${pid}/stat`)
  const user = liveContainerProcessUser(pid, { readFile: () => status.content })
  return { user, processStartTime: parseProcStartTime(stat.content), processInode: `${status.inode}:${stat.inode}` }
}

function liveContainerProcessUser(pid, dependencies = { readFile: readBoundedProcStatus }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 4_194_304) throw new Error("container PID1 is invalid")
  const statusPath = `/proc/${pid}/status`
  const status = dependencies.readFile(statusPath, "utf8")
  if (typeof status !== "string" || Buffer.byteLength(status, "utf8") > 128 * 1024) throw new Error("container PID1 status is invalid")
  const lines = status.split(/\r?\n/u)
  const parseEffective = (key) => {
    const matches = lines.filter((line) => line.startsWith(`${key}:`))
    if (matches.length !== 1) throw new Error(`container PID1 ${key} status is invalid`)
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)$`, "u").exec(matches[0])
    if (!match) throw new Error(`container PID1 ${key} status is invalid`)
    return Number(match[2])
  }
  const uid = parseEffective("Uid")
  const gid = parseEffective("Gid")
  if (uid !== 10001 || gid !== 10001) throw new Error("container PID1 effective identity is invalid")
  return `${uid}:${gid}`
}

function assertStableContainerProcess(before, after) {
  const stableFields = ["containerId", "imageId", "pid", "restartCount", "startedAt", "health", "processStartTime", "processInode"]
  if (before.running !== true || after.running !== true || stableFields.some((field) => before[field] !== after[field])) throw new Error("production container PID1 changed during attestation")
}

function productionProcessBindingDigest(value) {
  const generation = {
    containerId: text(value.containerId, "process binding container id", SHA256),
    imageId: text(value.imageId, "process binding image id", IMAGE_ID),
    pid: value.pid,
    restartCount: value.restartCount,
    startedAt: text(value.startedAt, "process binding started at"),
    processStartTime: text(value.processStartTime, "process binding start time", /^[0-9]+$/u),
    processInode: text(value.processInode, "process binding inode", /^[0-9]+:[0-9]+$/u),
  }
  if (!Number.isSafeInteger(generation.pid) || generation.pid <= 0 || !Number.isSafeInteger(generation.restartCount) || generation.restartCount < 0) {
    throw new Error("production process binding generation is invalid")
  }
  return createHash("sha256").update(JSON.stringify(generation)).digest("hex")
}

async function containerSnapshot(expectedImage) {
  text(expectedImage, "expected image id", IMAGE_ID)
  const template = '{"containerId":{{json .Id}},"imageId":{{json .Image}},"running":{{json .State.Running}},"pid":{{json .State.Pid}},"startedAt":{{json .State.StartedAt}},"health":{{json .State.Health.Status}},"user":{{json .Config.User}},"readOnlyRoot":{{json .HostConfig.ReadonlyRootfs}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}},"networkMode":{{json .HostConfig.NetworkMode}},"restartPolicy":{{json .HostConfig.RestartPolicy.Name}},"restartCount":{{json .RestartCount}},"privileged":{{json .HostConfig.Privileged}},"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}}}'
  const result = spawnSync(DOCKER, ["inspect", "--format", template, activeContainerId], {
    cwd: "/", encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" },
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.error || result.status !== 0) throw new Error("bounded production container inspection failed")
  const value = object(JSON.parse(result.stdout), "production container inspection")
  if (value.containerId !== activeContainerId || value.imageId !== expectedImage
    || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid > 4_194_304
    || !Number.isSafeInteger(value.restartCount) || value.restartCount < 0
    || typeof value.startedAt !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^\s]{1,64}Z$/u.test(value.startedAt)) {
    throw new Error("production container identity is invalid")
  }
  const ports = object(value.ports ?? {}, "published ports")
  const publishedPortCount = Object.values(ports).reduce((count, bindings) => count + (Array.isArray(bindings) ? bindings.length : 0), 0)
  const mounts = Array.isArray(value.mounts) ? value.mounts.map((raw) => {
    const mount = object(raw, "container mount")
    return { destination: mount.Destination, source: mount.Source, mode: mount.Mode, propagation: mount.Propagation, rw: mount.RW, type: mount.Type }
  }).sort((left, right) => String(left.destination).localeCompare(String(right.destination))) : []
  const expectedMounts = [
    { destination: "/home/ouro/.ouro-cli", source: PRODUCTION_RUNTIME_SOURCE, mode: "rw", propagation: "rprivate", rw: true, type: "bind" },
    { destination: "/home/ouro/AgentBundles/sanctuary.ouro", source: PRODUCTION_BUNDLE_SOURCE, mode: "rw", propagation: "rprivate", rw: true, type: "bind" },
    { destination: "/run/ouro-events", source: PRODUCTION_EVENT_SPOOL_SOURCE, mode: "ro", propagation: "rprivate", rw: false, type: "bind" },
    { destination: "/run/sanctuary/sabnzbd.ini", source: PRODUCTION_SAB_CONFIG_SOURCE, mode: "ro", propagation: "rprivate", rw: false, type: "bind" },
  ]
  const mountsExact = mounts.length === expectedMounts.length && expectedMounts.every((expected) => mounts.some((mount) => mount.destination === expected.destination && mount.source === expected.source && mount.mode === expected.mode && mount.propagation === expected.propagation && mount.rw === expected.rw && mount.type === expected.type))
  const securityExact = value.privileged === false && (value.capAdd === null || (Array.isArray(value.capAdd) && value.capAdd.length === 0))
    && JSON.stringify(value.capDrop) === JSON.stringify(["ALL"])
    && JSON.stringify(value.securityOpt) === JSON.stringify(["no-new-privileges"])
  const running = value.running === true
  if (!running) throw new Error("production container is not running")
  const configuredUser = text(value.user, "container user")
  if (configuredUser !== "10001:10001") throw new Error("production container configured identity is invalid")
  const processBefore = liveContainerProcessIdentity(value.pid)
  const reboundResult = spawnSync(DOCKER, ["inspect", "--format", template, activeContainerId], {
    cwd: "/", encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "pipe", "ignore"],
  })
  if (reboundResult.error || reboundResult.status !== 0) throw new Error("bounded production container rebound inspection failed")
  const rebound = object(JSON.parse(reboundResult.stdout ?? ""), "production container rebound inspection")
  const processAfter = liveContainerProcessIdentity(rebound.pid)
  assertStableContainerProcess({ ...value, ...processBefore }, { ...rebound, ...processAfter })
  const liveProcessUser = processAfter.user
  const processBindingDigest = productionProcessBindingDigest({ ...rebound, ...processAfter })
  const healthy = value.health === "healthy"
  const vault = vaultStatus(running, healthy)
  const milestones = recoveryMilestones(running, healthy)
  return {
    schemaVersion: 1,
    containerId: text(value.containerId, "container id", /^[0-9a-f]{64}$/u),
    imageId: expectedImage,
    running,
    health: text(value.health, "container health", /^(?:healthy|starting|unhealthy|missing)$/u),
    user: configuredUser,
    liveProcessUser,
    processBindingDigest,
    readOnlyRoot: value.readOnlyRoot === true,
    mountCount: mounts.length,
    mountsDigest: createHash("sha256").update(JSON.stringify(mounts)).digest("hex"),
    mountsExact,
    publishedPortCount,
    networkMode: text(value.networkMode, "container network mode"),
    securityExact,
    writableKeyExposure: mounts.some((mount) => String(mount.destination).endsWith("docker.sock") || mount.destination === KEY_ROOT),
    restartPolicy: text(value.restartPolicy, "container restart policy"),
    restartCount: value.restartCount,
    autostartExact: autostartFileExact() && await queryGraphqlAutostart(),
    updaterDisabled: updaterDisabled(expectedImage),
    ...vault,
    recoveryMilestones: milestones,
  }
}

function inspectRebootOwner(containerId = PRODUCTION_CONTAINER) {
  const template = '{"containerId":{{json .Id}},"name":{{json .Name}},"imageId":{{json .Image}},"running":{{json .State.Running}},"pid":{{json .State.Pid}},"startedAt":{{json .State.StartedAt}},"health":{{json .State.Health.Status}},"restartCount":{{json .RestartCount}}}'
  const result = spawnSync(DOCKER, ["inspect", "--format", template, containerId], {
    cwd: "/", encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024,
    env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.error || result.status !== 0) throw new Error("bounded reboot owner inspection failed")
  return object(JSON.parse(result.stdout ?? ""), "reboot owner inspection")
}

function runningRebootOwnerGeneration() {
  const before = inspectRebootOwner()
  if (before.name !== `/${PRODUCTION_CONTAINER}` || before.imageId !== expectedImageId || before.running !== true || before.health !== "healthy"
    || !Number.isSafeInteger(before.pid) || before.pid <= 0 || !Number.isSafeInteger(before.restartCount) || before.restartCount < 0) {
    throw new Error("reboot owner generation is invalid")
  }
  const processBefore = liveContainerProcessIdentity(before.pid)
  const after = inspectRebootOwner(before.containerId)
  const processAfter = liveContainerProcessIdentity(after.pid)
  assertStableContainerProcess({ ...before, ...processBefore }, { ...after, ...processAfter })
  return { ...after, ...processAfter, processBindingDigest: productionProcessBindingDigest({ ...after, ...processAfter }) }
}

function stopExactRebootOwner(expectedBinding) {
  text(expectedBinding, "reboot process binding", SHA256)
  const generation = runningRebootOwnerGeneration()
  if (generation.processBindingDigest !== expectedBinding) throw new Error("production process generation changed before exact stop")
  const result = spawnSync(DOCKER, ["stop", "--time", "30", generation.containerId], {
    cwd: "/", encoding: "utf8", timeout: 45_000, maxBuffer: 64 * 1024,
    env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "ignore", "ignore"],
  })
  if (result.error || result.status !== 0) throw new Error("exact production owner stop failed")
  const proof = { containerId: generation.containerId, imageId: generation.imageId, restartCount: generation.restartCount, startedAt: generation.startedAt, processBindingDigest: expectedBinding }
  verifyStoppedRebootOwner(proof)
  return proof
}

function verifyStoppedRebootOwner(proof) {
  const value = inspectRebootOwner(text(proof.containerId, "stopped owner container id", SHA256))
  if (value.containerId !== proof.containerId || value.name !== `/${PRODUCTION_CONTAINER}` || value.imageId !== proof.imageId
    || value.restartCount !== proof.restartCount || value.startedAt !== proof.startedAt || value.running !== false || value.pid !== 0) {
    throw new Error("exact stopped production owner generation changed")
  }
}

function denialTargetSnapshot(dependencies = { run: spawnSync }) {
  const template = '{"containerId":{{json .Id}},"imageId":{{json .Image}},"running":{{json .State.Running}},"status":{{json .State.Status}},"restartCount":{{json .RestartCount}},"startedAt":{{json .State.StartedAt}}}'
  const result = dependencies.run(DOCKER, ["inspect", "--format", template, "calibre-web"], {
    cwd: "/", encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
    env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.error || result.status !== 0) throw new Error("bounded denial target inspection failed")
  const value = object(JSON.parse(result.stdout ?? ""), "denial target inspection")
  exactKeys(value, ["containerId", "imageId", "running", "status", "restartCount", "startedAt"], "denial target inspection")
  const containerId = text(value.containerId, "denial target container id", SHA256)
  const imageId = text(value.imageId, "denial target image id", IMAGE_ID)
  const status = text(value.status, "denial target status", /^(?:created|running|paused|restarting|removing|exited|dead)$/u)
  const startedAt = text(value.startedAt, "denial target started at", /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^\s]{1,64}Z$/u)
  if (typeof value.running !== "boolean" || !Number.isSafeInteger(value.restartCount) || value.restartCount < 0) {
    throw new Error("denial target lifecycle is invalid")
  }
  return {
    containerIdDigest: createHash("sha256").update(containerId).digest("hex"),
    imageDigest: createHash("sha256").update(imageId).digest("hex"),
    running: value.running,
    status,
    restartCount: value.restartCount,
    startedAtDigest: createHash("sha256").update(startedAt).digest("hex"),
  }
}

function containerOwnerSnapshot(expectedImage) {
  text(expectedImage, "expected image id", IMAGE_ID)
  const template = '{"containerId":{{json .Id}},"imageId":{{json .Image}}}'
  const result = spawnSync(DOCKER, ["inspect", "--format", template, activeContainerId], {
    cwd: "/", encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
    env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.error || result.status !== 0) throw new Error("bounded production owner inspection failed")
  const value = object(JSON.parse(result.stdout), "production owner inspection")
  if (value.containerId !== activeContainerId || value.imageId !== expectedImage) throw new Error("production owner identity is invalid")
  return {
    imageId: expectedImage,
    containerId: text(value.containerId, "container id", /^[0-9a-f]{64}$/u),
  }
}

function containerRestartSnapshot(expectedImage) {
  text(expectedImage, "expected image id", IMAGE_ID)
  const template = '{"containerId":{{json .Id}},"imageId":{{json .Image}},"running":{{json .State.Running}},"health":{{json .State.Health.Status}},"restartCount":{{json .RestartCount}}}'
  const result = spawnSync(DOCKER, ["inspect", "--format", template, activeContainerId], {
    cwd: "/", encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
    env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.error || result.status !== 0) throw new Error("bounded production restart inspection failed")
  const value = object(JSON.parse(result.stdout), "production restart inspection")
  if (value.containerId !== activeContainerId || value.imageId !== expectedImage || !Number.isSafeInteger(value.restartCount) || value.restartCount < 0) throw new Error("production restart identity is invalid")
  return {
    imageId: expectedImage, containerId: text(value.containerId, "container id", SHA256),
    running: value.running === true, health: text(value.health, "container health", /^(?:healthy|starting|unhealthy|missing)$/u),
    restartCount: value.restartCount,
  }
}

function recoveryPath(id) { return `${RECOVERY_ROOT}/${id}.json` }

function persistRecovery(record) {
  mkdirSync(RECOVERY_ROOT, { recursive: true, mode: 0o700 })
  chmodSync(RECOVERY_ROOT, 0o700)
  chownSync(RECOVERY_ROOT, 0, 0)
  const target = recoveryPath(record.id)
  const temporary = `${target}.tmp-${process.pid}`
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try { writeFileSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
  chownSync(temporary, 0, 0)
  renameSync(temporary, target)
  const directory = openSync(RECOVERY_ROOT, constants.O_RDONLY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

function removeRecovery(id) {
  unlinkSync(recoveryPath(id))
  const directory = openSync(RECOVERY_ROOT, constants.O_RDONLY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

function permissions(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("permissions are invalid")
  const result = value.map((item) => text(item, "permission", PERMISSION)).sort()
  if (new Set(result).size !== result.length) throw new Error("permissions are ambiguous")
  return result
}

function canonicalHealthProbeInput(input) {
  const value = object(input, "health probe input")
  exactKeys(value, ["label", "scenarioHandleDigest", "ownerImageDigest", "ownerContainerDigest"], "health probe input")
  if (!HEALTH_PROBE_LABELS.has(value.label)) throw new Error("health probe label is invalid")
  for (const key of ["scenarioHandleDigest", "ownerImageDigest", "ownerContainerDigest"]) text(value[key], `health probe ${key}`, SHA256)
  return value
}

function canonicalHealthProbeRequest(input) {
  const value = object(input, "health probe request")
  exactKeys(value, ["label", "scenarioHandleDigest"], "health probe request")
  if (!HEALTH_PROBE_LABELS.has(value.label)) throw new Error("health probe label is invalid")
  text(value.scenarioHandleDigest, "health probe scenario digest", SHA256)
  return value
}

function healthProbeDockerArgs(mode, input) {
  if (mode !== "run" && mode !== "stop" && mode !== "recover") throw new Error("health probe mode is invalid")
  const value = canonicalHealthProbeInput(input)
  return [
    "exec", activeContainerId, "/usr/local/bin/node", HEALTH_PROBE_ENTRY, mode,
    "--label", value.label,
    "--scenario", value.scenarioHandleDigest,
    "--owner-image", value.ownerImageDigest,
    "--owner-container", value.ownerContainerDigest,
  ]
}

function healthProbeFinalizeDockerArgs(before, after) {
  const initial = canonicalHealthProbeInput(before)
  const observed = canonicalHealthProbeInput(after)
  return [
    "exec", activeContainerId, "/usr/local/bin/node", HEALTH_PROBE_ENTRY, "finalize",
    "--label", initial.label,
    "--scenario", initial.scenarioHandleDigest,
    "--owner-image", initial.ownerImageDigest,
    "--owner-container", initial.ownerContainerDigest,
    "--owner-image-after", observed.ownerImageDigest,
    "--owner-container-after", observed.ownerContainerDigest,
  ]
}

function requireStableHealthProbeOwner(before, after) {
  const initial = canonicalHealthProbeInput(before)
  const observed = canonicalHealthProbeInput(after)
  if (initial.label !== observed.label || initial.scenarioHandleDigest !== observed.scenarioHandleDigest) throw new Error("health probe scenario binding drifted")
  if (initial.ownerImageDigest !== observed.ownerImageDigest || initial.ownerContainerDigest !== observed.ownerContainerDigest) throw new Error("health probe owner binding drifted")
}

function healthProbeReceiptPath(scenarioHandleDigest) {
  return `${PRODUCTION_BUNDLE_SOURCE}/state/acceptance/health-probe-receipts/${scenarioHandleDigest}.json`
}

function healthProbeWorkspacePath(scenarioHandleDigest) {
  return `${PRODUCTION_BUNDLE_SOURCE}/state/acceptance/health-probe-workspaces/${scenarioHandleDigest}`
}

function healthProbePendingPath(scenarioHandleDigest) {
  return `${PRODUCTION_BUNDLE_SOURCE}/state/acceptance/health-probe-pending/${scenarioHandleDigest}.json`
}

function healthProbeProcessPath(scenarioHandleDigest) {
  return `${PRODUCTION_BUNDLE_SOURCE}/state/acceptance/health-probe-processes/${scenarioHandleDigest}.json`
}

function healthOwnerMutationActive() {
  if (activeHealthProbes.size > 0) return true
  for (const root of ["health-probe-workspaces", "health-probe-pending", "health-probe-processes"]
    .map((name) => `${PRODUCTION_BUNDLE_SOURCE}/state/acceptance/${name}`)) {
    let directory
    try { directory = opendirSync(root) } catch (error) { if (error.code === "ENOENT") continue; throw error }
    try { if (directory.readSync() !== null) return true } finally { directory.closeSync() }
  }
  return false
}

function healthProbeArtifactDisposition({ receipt, workspace, pending }) {
  if (receipt) return "complete"
  if (workspace || pending) return "recovery_required"
  return "absent"
}

function healthProbeOperationBudgets() {
  return { startMaxMs: 115_000, completeStatusMaxMs: 130_000, recoveryMaxMs: 85_000, composedCaptureMaxMs: 165_000 }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SCHEDULER_COMMAND = "/usr/local/bin/node /opt/ouro/dist/heart/daemon/ouro-entry.js poke sanctuary --habit sanctuary-health --trigger cron"
const SCHEDULER_CRONTAB = "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab"

function canonicalIso(value) {
  if (typeof value !== "string") return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function safeMacEqual(observed, expected) {
  return typeof observed === "string" && SHA256.test(observed) && timingSafeEqual(Buffer.from(observed, "hex"), Buffer.from(expected, "hex"))
}

function requireExactSchedulerReceipt(scheduler, request, identityKey, phases) {
  exactKeys(scheduler, ["after", "before", "deliveryDelta", "label", "nonReplay", "occurrenceId", "privateTurnCount", "providerInvocationCount", "receiptMac", "recordedAt", "runnerId", "scenarioHandleDigest", "schedulerOrigin", "schemaVersion", "supervisor", "sweep", "sweepDelta", "trigger"], "scheduler receipt")
  const before = object(scheduler.before, "scheduler before cursor")
  const after = object(scheduler.after, "scheduler after cursor")
  const sweep = object(scheduler.sweep, "scheduler sweep")
  const supervisor = object(scheduler.supervisor, "scheduler supervisor")
  const origin = object(scheduler.schedulerOrigin, "scheduler origin")
  exactKeys(before, ["deliveryCount", "sweepCount"], "scheduler before cursor")
  exactKeys(after, ["deliveryCount", "sweepCount"], "scheduler after cursor")
  exactKeys(sweep, ["deliveryId", "digestDue", "opened", "recordDigest", "recovered"], "scheduler sweep")
  exactKeys(supervisor, ["args", "binaryPath", "childCount", "childPid", "crontabPath", "daemonPid", "healthy", "manifest", "namespace", "renderedCrontab", "schemaVersion"], "scheduler supervisor")
  exactKeys(origin, ["invocationPid", "invocationStartTime", "occurrenceId", "parentPid", "parentStartTime", "proofMac", "scenarioHandleDigest", "schedulerRunId", "slot"], "scheduler origin")
  const manifest = Array.isArray(supervisor.manifest) ? supervisor.manifest : []
  if (manifest.length !== 1) throw new Error("scheduler manifest is invalid")
  const job = object(manifest[0], "scheduler manifest job")
  exactKeys(job, ["agent", "command", "id", "lastRun", "schedule", "taskId", "taskPath"], "scheduler manifest job")
  const unsignedScheduler = Object.fromEntries(Object.entries(scheduler).filter(([key]) => key !== "receiptMac"))
  const expectedReceiptMac = createHmac("sha256", identityKey).update(`sanctuary-scheduler-liveness-receipt-v2\0${JSON.stringify(unsignedScheduler)}`).digest("hex")
  const proofCommand = {
    kind: "habit.scheduler-fire", agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron",
    slot: origin.slot, occurrenceId: origin.occurrenceId, schedulerRunId: origin.schedulerRunId,
    invocationPid: origin.invocationPid, parentPid: origin.parentPid, parentStartTime: origin.parentStartTime,
    invocationStartTime: origin.invocationStartTime, scenarioHandleDigest: origin.scenarioHandleDigest,
  }
  const expectedProofMac = createHmac("sha256", identityKey).update(JSON.stringify(proofCommand)).digest("hex")
  if (scheduler.schemaVersion !== "sanctuary-scheduler-liveness-receipt-v1" || scheduler.label !== request.label
    || scheduler.scenarioHandleDigest !== request.scenarioHandleDigest || scheduler.trigger !== "cron"
    || !UUID.test(scheduler.runnerId) || !canonicalIso(scheduler.recordedAt)
    || !Number.isSafeInteger(before.sweepCount) || before.sweepCount < 0 || !Number.isSafeInteger(before.deliveryCount) || before.deliveryCount < 0
    || after.sweepCount !== before.sweepCount + 1 || after.deliveryCount !== before.deliveryCount
    || scheduler.sweepDelta !== 1 || scheduler.deliveryDelta !== 0 || scheduler.providerInvocationCount !== 0 || scheduler.privateTurnCount !== 0 || scheduler.nonReplay !== true
    || !SHA256.test(sweep.recordDigest) || sweep.opened !== 0 || sweep.recovered !== 0 || sweep.digestDue !== false || sweep.deliveryId !== null
    || phases.length !== 1 || sweep.recordDigest !== phases[0]?.sweepReceiptDigest
    || supervisor.schemaVersion !== "supercronic-supervisor-snapshot-v1" || supervisor.daemonPid !== 1 || supervisor.childCount !== 1
    || !Number.isSafeInteger(supervisor.childPid) || supervisor.childPid <= 1 || supervisor.healthy !== true
    || supervisor.binaryPath !== "/usr/local/bin/supercronic" || supervisor.crontabPath !== SCHEDULER_CRONTAB
    || JSON.stringify(supervisor.args) !== JSON.stringify(["-split-logs", "-inotify", SCHEDULER_CRONTAB]) || supervisor.namespace !== "habit:sanctuary"
    || job.id !== "sanctuary:sanctuary-health" || job.agent !== "sanctuary" || job.taskId !== "sanctuary-health" || job.schedule !== "*/15 * * * *"
    || (job.lastRun !== null && !canonicalIso(job.lastRun)) || job.command !== SCHEDULER_COMMAND || job.taskPath !== "/home/ouro/AgentBundles/sanctuary.ouro/habits/sanctuary-health.md"
    || typeof supervisor.renderedCrontab !== "string" || !supervisor.renderedCrontab.includes(`# ouro:habit:sanctuary:sanctuary:sanctuary-health\n*/15 * * * * ${SCHEDULER_COMMAND}\n`)
    || typeof origin.slot !== "string" || !canonicalIso(origin.slot) || scheduler.occurrenceId !== `cron:${origin.slot}` || origin.occurrenceId !== scheduler.occurrenceId
    || !UUID.test(origin.schedulerRunId) || origin.scenarioHandleDigest !== request.scenarioHandleDigest
    || !Number.isSafeInteger(origin.invocationPid) || origin.invocationPid <= 1 || !Number.isSafeInteger(origin.parentPid) || origin.parentPid !== supervisor.childPid
    || typeof origin.parentStartTime !== "string" || !/^[0-9]+$/u.test(origin.parentStartTime)
    || typeof origin.invocationStartTime !== "string" || !/^[0-9]+$/u.test(origin.invocationStartTime)
    || !safeMacEqual(origin.proofMac, expectedProofMac) || !safeMacEqual(scheduler.receiptMac, expectedReceiptMac)) {
    throw new Error("scheduler receipt semantics are invalid")
  }
}

function requireHealthProbeCompleteAttestationUnchecked(receipt, snapshot, input, readSchedulerIdentityKey = () => readFileSync(`${PRODUCTION_BUNDLE_SOURCE}/state/senses/telegram/identity.key`, "utf8").trim()) {
  const request = canonicalHealthProbeRequest(input)
  const value = object(receipt, "health probe receipt")
  exactKeys(value, HEALTH_PROBE_RECEIPT_KEYS, "health probe receipt")
  const observed = object(snapshot, "health probe complete owner")
  const phases = Array.isArray(value.phases) ? value.phases.map((phase) => object(phase, "health probe phase")) : []
  const digestFields = ["ownerImageDigestBefore", "ownerImageDigestAfter", "ownerContainerDigestBefore", "ownerContainerDigestAfter", "beforeStateDigest", "restoredStateDigest", "cronFingerprintBefore", "cronFingerprintAfter", "fixtureSequenceDigest"]
  const booleanFields = ["cronRegisteredBefore", "cronRegisteredAfter", "cronDegradedBefore", "cronDegradedAfter", "workspaceAbsent", "socketAbsent", "snapshotAbsent", "realCheckEquivalent", "productionRestored"]
  for (const phase of phases) exactKeys(phase, ["deliveryKind", "deliveryReceiptDigest", "digestDue", "fixtureStatus", "name", "opened", "ordinal", "recovered", "sweepReceiptDigest", "trigger"], "health probe phase")
  const scheduler = request.label === "unit-16f-cron-fingerprint" ? object(value.schedulerReceipt, "scheduler receipt") : null
  if (scheduler) requireExactSchedulerReceipt(scheduler, request, readSchedulerIdentityKey(), phases)
  const unit16fPhase = phases.length === 1 && phases[0].ordinal === 1 && phases[0].name === "cron-unchanged" && phases[0].trigger === "cron"
    && phases[0].fixtureStatus === null && phases[0].opened === 0 && phases[0].recovered === 0 && phases[0].digestDue === false
    && phases[0].deliveryKind === null && phases[0].deliveryReceiptDigest === null && SHA256.test(phases[0].sweepReceiptDigest)
  const unit16fEvidence = request.label !== "unit-16f-cron-fingerprint" || (
    digestFields.every((field) => typeof value[field] === "string" && SHA256.test(value[field]))
    && booleanFields.every((field) => typeof value[field] === "boolean") && canonicalIso(value.effectiveNow)
    && value.clockMode === "ambient" && value.providerInvocationCount === 0 && value.privateTurnCount === 0 && value.deliveryCount === 0
    && value.fixtureSequenceDigest === createHash("sha256").update(JSON.stringify([])).digest("hex")
    && value.cronFingerprintBefore === value.cronFingerprintAfter && value.cronRegisteredBefore === true && value.cronRegisteredAfter === true
    && value.cronDegradedBefore === false && value.cronDegradedAfter === false && value.workspaceAbsent === true && value.socketAbsent === true
    && value.snapshotAbsent === true && value.realCheckEquivalent === true && value.productionRestored === true && unit16fPhase
  )
  if (value.schemaVersion !== "sanctuary-health-probe-receipt-v1" || value.label !== request.label
    || value.scenarioHandleDigest !== request.scenarioHandleDigest
    || !SHA256.test(value.ownerImageDigestBefore) || !SHA256.test(value.ownerContainerDigestBefore)
    || !SHA256.test(value.ownerImageDigestAfter) || !SHA256.test(value.ownerContainerDigestAfter)
    || value.ownerImageDigestBefore !== value.ownerImageDigestAfter || value.ownerContainerDigestBefore !== value.ownerContainerDigestAfter
    || observed.imageId !== `sha256:${value.ownerImageDigestAfter}` || observed.containerId !== value.ownerContainerDigestAfter
    || observed.running !== true || observed.health !== "healthy" || !unit16fEvidence
    || (request.label !== "unit-16f-cron-fingerprint" && value.schedulerReceipt !== null)) {
    throw new Error("health probe complete attestation is invalid")
  }
}

function requireHealthProbeCompleteAttestation(receipt, snapshot, input, readSchedulerIdentityKey) {
  try { requireHealthProbeCompleteAttestationUnchecked(receipt, snapshot, input, readSchedulerIdentityKey) }
  catch { throw new Error("health probe complete attestation is invalid") }
}

function finalizeHealthProbeAfterAttestation(receipt, snapshot, request, finalize, readSchedulerIdentityKey) {
  requireHealthProbeCompleteAttestation(receipt, snapshot, request, readSchedulerIdentityKey)
  return finalize()
}

function completeHealthProbeFromReceipt(request, snapshot, readReceipt) {
  const value = object(snapshot, "health probe complete owner")
  requireHealthProbeCompleteAttestation(readReceipt(), value, request)
  return { state: "complete", containerSnapshot: value }
}

function readHealthProbeReceipt(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = fstatSync(fd)
    if (!metadata.isFile() || metadata.uid !== 10001 || (metadata.mode & 0o777) !== 0o600 || metadata.size > MAX_REQUEST) {
      throw new Error("health probe receipt metadata is invalid")
    }
    return object(JSON.parse(readFileSync(fd, "utf8")), "health probe receipt")
  } finally { closeSync(fd) }
}

function readHealthProbePendingReceipt(file) {
  const envelope = readHealthProbeReceipt(file)
  exactKeys(envelope, ["receipt", "schemaVersion"], "health probe pending envelope")
  if (envelope.schemaVersion !== "sanctuary-health-probe-pending-v1") throw new Error("health probe pending envelope is invalid")
  return object(envelope.receipt, "health probe pending receipt")
}

function attestHealthProbeProcessAbsent(input, dependencies = {
  run: spawnSync,
  markerPresent: () => Boolean(statIfPresent(healthProbeProcessPath(input.scenarioHandleDigest))),
}) {
  const value = canonicalHealthProbeInput(input)
  const stopped = dependencies.run(DOCKER, healthProbeDockerArgs("stop", value), {
    cwd: "/", encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024,
    env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "ignore", "ignore"],
  })
  if (stopped.error || stopped.status !== 0 || dependencies.markerPresent()) throw new Error("health probe in-container process termination failed")
}

async function waitForHealthProbeProcessMarker(record, timeoutMs = 5_000) {
  const marker = healthProbeProcessPath(record.input.scenarioHandleDigest)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const metadata = statIfPresent(marker)
    if (metadata) {
      if (!metadata.isFile() || metadata.uid !== 10001 || (metadata.mode & 0o777) !== 0o600) throw new Error("health probe process marker metadata is invalid")
      return
    }
    if (record.state !== "running") throw new Error("health probe exited before process registration")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("health probe process registration timed out")
}

async function startHealthProbe(input) {
  const value = canonicalHealthProbeInput(input)
  const existing = activeHealthProbes.get(value.scenarioHandleDigest)
  const artifacts = {
    receipt: statIfPresent(healthProbeReceiptPath(value.scenarioHandleDigest)),
    workspace: statIfPresent(healthProbeWorkspacePath(value.scenarioHandleDigest)),
    pending: statIfPresent(healthProbePendingPath(value.scenarioHandleDigest)),
  }
  if (existing || healthProbeArtifactDisposition(artifacts) !== "absent" || statIfPresent(healthProbeProcessPath(value.scenarioHandleDigest))) {
    throw new Error("health probe requires inspect-before-retry")
  }
  const child = spawn(DOCKER, healthProbeDockerArgs("run", value), {
    cwd: "/", env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: "ignore",
  })
  const record = { input: value, child, state: "running", exitCode: null }
  activeHealthProbes.set(value.scenarioHandleDigest, record)
  child.once("error", () => {
    if (record.state !== "terminating") record.state = "failed"
    record.exitCode = -1
  })
  child.once("exit", (code) => {
    record.state = record.state === "terminating" ? "terminated" : code === 0 ? "exited" : "failed"
    record.exitCode = code
  })
  child.unref()
  record.readyPromise = waitForHealthProbeProcessMarker(record)
  await record.readyPromise
  return {
    state: "started",
    operationDigest: createHash("sha256").update(JSON.stringify({ operation: "start_health_probe", ...value })).digest("hex"),
  }
}

function statIfPresent(file) {
  try { return statSync(file) } catch (error) { if (error.code === "ENOENT") return null; throw error }
}

async function healthProbeStatus(input, fullSnapshot = () => containerSnapshot(expectedImageId)) {
  const request = canonicalHealthProbeRequest(input)
  const receipt = statIfPresent(healthProbeReceiptPath(request.scenarioHandleDigest))
  if (receipt) {
    if (!receipt.isFile() || receipt.uid !== 10001 || (receipt.mode & 0o777) !== 0o600) throw new Error("health probe receipt metadata is invalid")
    const snapshot = object(await fullSnapshot(), "health probe complete owner")
    return completeHealthProbeFromReceipt(request, snapshot, () => readHealthProbeReceipt(healthProbeReceiptPath(request.scenarioHandleDigest)))
  }
  const record = activeHealthProbes.get(request.scenarioHandleDigest)
  if (!record) return { state: healthProbeArtifactDisposition({
    receipt: null,
    workspace: statIfPresent(healthProbeWorkspacePath(request.scenarioHandleDigest)),
    pending: statIfPresent(healthProbePendingPath(request.scenarioHandleDigest)),
  }) }
  if (record.input.label !== request.label) throw new Error("health probe scenario binding drifted")
  if (record.state === "failed") return { state: "failed" }
  if (record.state === "running") return { state: "running" }
  if (record.state === "terminating" || record.state === "terminated" || record.state === "recovering") return { state: "recovery_required" }
  const snapshot = object(await fullSnapshot(), "health probe production owner")
  const value = healthProbeCoordinates({ targetId: TARGET_HOST, ...request }, snapshot)
  requireStableHealthProbeOwner(record.input, value)
  const finalized = finalizeHealthProbeAfterAttestation(
    readHealthProbePendingReceipt(healthProbePendingPath(value.scenarioHandleDigest)), snapshot, request,
    () => spawnSync(DOCKER, healthProbeFinalizeDockerArgs(record.input, value), {
      cwd: "/", encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024,
      env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "ignore", "ignore"],
    }),
  )
  if (finalized.error || finalized.status !== 0) throw new Error("health probe final attestation failed")
  const finalReceipt = statIfPresent(healthProbeReceiptPath(value.scenarioHandleDigest))
  if (!finalReceipt || !finalReceipt.isFile() || finalReceipt.uid !== 10001 || (finalReceipt.mode & 0o777) !== 0o600) {
    throw new Error("health probe final receipt is absent or invalid")
  }
  requireHealthProbeCompleteAttestation(readHealthProbeReceipt(healthProbeReceiptPath(value.scenarioHandleDigest)), snapshot, request)
  activeHealthProbes.delete(value.scenarioHandleDigest)
  return { state: "complete", containerSnapshot: snapshot }
}

function healthProbeChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForHealthProbeChildExit(child, timeoutMs) {
  if (healthProbeChildExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = (exited) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      child.removeListener("exit", onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    child.once("exit", onExit)
    timer = setTimeout(() => finish(healthProbeChildExited(child)), timeoutMs)
    if (healthProbeChildExited(child)) finish(true)
  })
}

function terminateHealthProbeChild(record, options = {}) {
  if (record.terminationPromise) return record.terminationPromise
  if (record.state !== "running" && record.state !== "terminating") return Promise.resolve()
  const termGraceMs = options.termGraceMs ?? HEALTH_PROBE_TERM_GRACE_MS
  const killGraceMs = options.killGraceMs ?? HEALTH_PROBE_KILL_GRACE_MS
  record.state = "terminating"
  const termination = (async () => {
    try {
      if (!healthProbeChildExited(record.child)) record.child.kill("SIGTERM")
      if (!await waitForHealthProbeChildExit(record.child, termGraceMs)) {
        record.child.kill("SIGKILL")
        if (!await waitForHealthProbeChildExit(record.child, killGraceMs)) throw new Error("health probe child did not exit")
      }
      record.state = "terminated"
    } catch (error) {
      record.state = "failed"
      throw error
    }
  })()
  record.terminationPromise = termination
  return termination
}

async function recoverAfterHealthProbeTermination(record, recovery, options = {}) {
  if (record) await terminateHealthProbeChild(record, options)
  return await recovery()
}

async function recoverHealthProbe(input) {
  const value = canonicalHealthProbeInput(input)
  const record = activeHealthProbes.get(value.scenarioHandleDigest)
  if (record && JSON.stringify(record.input) !== JSON.stringify(value)) throw new Error("health probe owner binding drifted")
  if (record?.recoveryPromise) return await record.recoveryPromise
  const recovery = (async () => {
    if (record?.readyPromise) {
      try { await record.readyPromise } catch { /* recovery still terminates an unready launch */ }
    }
    const processMarker = statIfPresent(healthProbeProcessPath(value.scenarioHandleDigest))
    if (processMarker) {
      if (!processMarker.isFile() || processMarker.uid !== 10001 || (processMarker.mode & 0o777) !== 0o600) throw new Error("health probe process marker metadata is invalid")
    }
    attestHealthProbeProcessAbsent(value)
    return await recoverAfterHealthProbeTermination(record, () => {
      if (record) record.state = "recovering"
      const workspace = statIfPresent(healthProbeWorkspacePath(value.scenarioHandleDigest))
      const pending = statIfPresent(healthProbePendingPath(value.scenarioHandleDigest))
      if (!workspace && !pending) {
        activeHealthProbes.delete(value.scenarioHandleDigest)
        return { recovered: true }
      }
      const result = spawnSync(DOCKER, healthProbeDockerArgs("recover", value), {
        cwd: "/", encoding: "utf8", timeout: 45_000, maxBuffer: 64 * 1024,
        env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "ignore", "ignore"],
      })
      if (result.error || result.status !== 0 || statIfPresent(healthProbeWorkspacePath(value.scenarioHandleDigest)) || statIfPresent(healthProbePendingPath(value.scenarioHandleDigest))) {
        throw new Error("health probe recovery failed")
      }
      activeHealthProbes.delete(value.scenarioHandleDigest)
      return { recovered: true }
    })
  })()
  if (record) record.recoveryPromise = recovery
  try {
    return await recovery
  } catch (error) {
    if (record) record.recoveryPromise = undefined
    throw error
  }
}

function healthProbeCoordinates(payload, snapshot) {
  if (payload.targetId !== TARGET_HOST) throw new Error("target host is invalid")
  const label = text(payload.label, "health probe label")
  if (!HEALTH_PROBE_LABELS.has(label)) throw new Error("health probe label is invalid")
  const scenarioHandleDigest = text(payload.scenarioHandleDigest, "health probe scenario digest", SHA256)
  const ownerImage = text(snapshot.imageId, "health probe owner image", IMAGE_ID)
  const ownerContainerDigest = text(snapshot.containerId, "health probe owner container", SHA256)
  if (expectedImageId && ownerImage !== expectedImageId) throw new Error("health probe production owner drifted")
  return { label, scenarioHandleDigest, ownerImageDigest: ownerImage.slice("sha256:".length), ownerContainerDigest }
}

function createDispatchDrain() {
  let accepting = true
  const inFlight = new Set()
  return {
    run(operation) {
      if (!accepting) return Promise.reject(new Error("host broker is shutting down"))
      const task = Promise.resolve().then(operation)
      inFlight.add(task)
      void task.finally(() => inFlight.delete(task)).catch(() => {})
      return task
    },
    async stopAndDrain() {
      accepting = false
      await Promise.allSettled([...inFlight])
    },
  }
}

function createHealthProbeOperationCoordinator() {
  const tails = new Map()
  const recovered = new Set()
  const enqueue = (scenario, operation) => {
    const prior = tails.get(scenario) ?? Promise.resolve()
    const task = prior.catch(() => {}).then(operation)
    tails.set(scenario, task)
    void task.finally(() => { if (tails.get(scenario) === task) tails.delete(scenario) }).catch(() => {})
    return task
  }
  return {
    start(scenario, operation) {
      if (recovered.has(scenario)) return Promise.reject(new Error("health probe recovered scenario cannot restart"))
      return enqueue(scenario, operation)
    },
    recover(scenario, operation) {
      recovered.add(scenario)
      return enqueue(scenario, operation)
    },
  }
}

function createOwnerMutationCoordinator() {
  let ownerTail = Promise.resolve()
  let pendingOperations = 0
  let rebootReservation = null
  const activeHealth = new Set()
  const enqueue = (operation) => {
    if (rebootReservation !== null) return Promise.reject(new Error("owner mutation refused by reboot reservation"))
    pendingOperations += 1
    const task = ownerTail.catch(() => {}).then(async () => {
      try { return await operation() } finally { pendingOperations -= 1 }
    })
    ownerTail = task.then(() => {}, () => {})
    return task
  }
  return {
    active() { return pendingOperations > 0 },
    async reserveReboot(reservationId, processBindingDigest, operation) {
      text(reservationId, "reboot reservation", SHA256)
      text(processBindingDigest, "reboot process binding", SHA256)
      if (rebootReservation !== null) throw new Error("reboot reservation already exists")
      rebootReservation = { id: reservationId, processBindingDigest, stoppedProof: null, attempted: false }
      try {
        await ownerTail.catch(() => {})
        if (pendingOperations !== 0 || activeHealth.size !== 0) throw new Error("reboot reservation could not drain owner mutations")
        return await operation()
      } catch (error) {
        rebootReservation = null
        throw error
      }
    },
    async stopRebootOwner(reservationId, processBindingDigest, operation) {
      text(reservationId, "reboot reservation", SHA256)
      text(processBindingDigest, "reboot process binding", SHA256)
      if (rebootReservation?.id !== reservationId || rebootReservation.processBindingDigest !== processBindingDigest) throw new Error("reboot reservation process binding is absent or mismatched")
      if (rebootReservation.stoppedProof !== null) throw new Error("reboot owner was already stopped")
      const proof = object(await operation(), "stopped reboot owner proof")
      if (proof.processBindingDigest !== processBindingDigest) throw new Error("stopped reboot owner proof binding is invalid")
      rebootReservation.stoppedProof = proof
      return proof
    },
    async commitReboot(reservationId, processBindingDigest, operation) {
      text(reservationId, "reboot reservation", SHA256)
      text(processBindingDigest, "reboot process binding", SHA256)
      if (rebootReservation?.id !== reservationId || rebootReservation.processBindingDigest !== processBindingDigest) throw new Error("reboot reservation is absent or mismatched")
      if (rebootReservation.stoppedProof === null) throw new Error("reboot owner is not stopped")
      if (rebootReservation.attempted) throw new Error("reboot commit was already attempted")
      const markAttempted = () => {
        if (rebootReservation.attempted) throw new Error("reboot commit was already attempted")
        rebootReservation.attempted = true
      }
      const result = await operation(rebootReservation.stoppedProof, markAttempted)
      if (!rebootReservation.attempted) throw new Error("reboot commit was not attempted")
      return result
    },
    healthStart(scenario, operation) {
      text(scenario, "health owner scenario", SHA256)
      return enqueue(async () => {
        if (activeHealth.has(scenario)) throw new Error("health probe scenario is already active")
        activeHealth.add(scenario)
        try { return await operation() } catch (error) { activeHealth.delete(scenario); throw error }
      })
    },
    healthRecover(scenario, operation) {
      text(scenario, "health owner scenario", SHA256)
      return enqueue(async () => {
        try { const result = await operation(); activeHealth.delete(scenario); return result } catch (error) { throw error }
      })
    },
    healthOperation(scenario, operation) {
      text(scenario, "health owner scenario", SHA256)
      return enqueue(operation)
    },
    interactive(operation) {
      return enqueue(async () => {
        if (activeHealth.size > 0) throw new Error("owner mutation refused while health probe is active")
        return await operation()
      })
    },
  }
}

function createInteractiveRestartDriver() {
  const records = new Map()
  const tasks = new Set()
  return {
    poll(input, operation) {
      const key = input.scenarioHandleDigest
      const existing = records.get(key)
      if (existing?.state === "complete") return { state: "complete", receipt: existing.receipt }
      if (existing?.state === "failed") return { state: "failed", errorDigest: existing.errorDigest }
      if (existing) return { state: "waiting" }
      records.set(key, { state: "waiting", operation })
      return { state: "waiting" }
    },
    arm(key) {
      const record = records.get(key)
      if (!record || record.state !== "waiting" || !record.operation) return
      const operation = record.operation
      records.set(key, { state: "waiting" })
      const task = Promise.resolve().then(operation).then(
          (receipt) => { records.set(key, { state: "complete", receipt }) },
          (error) => { records.set(key, { state: "failed", errorDigest: createHash("sha256").update(interactiveFailureCategory(error)).digest("hex") }) },
      )
      tasks.add(task)
      void task.finally(() => tasks.delete(task)).catch(() => {})
    },
    async stopAndDrain() { await Promise.allSettled([...tasks]) },
  }
}

function armRestartAfterResponseClosed(connection, scenarioHandleDigest, driver = interactiveRestartDriver) {
  let written = false
  let closed = false
  let armed = false
  const maybeArm = () => {
    if (!armed && written && closed) { armed = true; driver.arm(scenarioHandleDigest) }
  }
  connection.once("close", () => { closed = true; maybeArm() })
  return () => { written = true; maybeArm() }
}

function interactiveFailureCategory(error) {
  const message = error instanceof Error ? error.message : ""
  if (/inspect-before-retry/u.test(message)) return "inspect-before-retry"
  if (/production runtime/u.test(message)) return "production-runtime"
  if (/owner restart|did not return|restart failed/u.test(message)) return "owner-restart"
  if (/prepared receipt/u.test(message)) return "prepared-receipt"
  if (/reconciliation/u.test(message)) return "reconciliation"
  if (/receipt/u.test(message)) return "receipt-validation"
  return "unknown"
}

async function waitForInteractiveRuntimeReady(input, dependencies) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const readiness = object(await dependencies.runtime("interactive_runtime_ready", input), "interactive runtime readiness")
    exactKeys(readiness, ["ready"], "interactive runtime readiness")
    if (readiness.ready === true) return
    if (readiness.ready !== false) throw new Error("interactive runtime readiness is invalid")
    await dependencies.sleep(1_000)
  }
  throw new Error("interactive production runtime readiness timed out")
}

function canonicalInteractiveRequest(input, expectedLabel) {
  const value = object(input, "interactive driver input")
  exactKeys(value, ["label", "scenarioHandleDigest"], "interactive driver input")
  if (value.label !== expectedLabel) throw new Error("interactive driver label is invalid")
  text(value.scenarioHandleDigest, "interactive driver scenario digest", SHA256)
  return value
}

const DUPLICATE_RECEIPT_KEYS = [
  "schemaVersion", "phase", "label", "scenarioHandleDigest", "approvalIdDigest", "checkpointDigest",
  "suspendedSessionRevisionDigest", "approvalEpochBefore", "callbackAttempts", "distinctQueryCount",
  "callbackDataDigest", "barrierObserved", "settledCount", "claimCount", "mutationCount",
  "staleReplayAttempts", "staleReplaySettled", "staleReplayMutationCount", "promptTerminal",
  "writeCredentialObserved",
]
const TIMEOUT_RECEIPT_KEYS = [
  "schemaVersion", "phase", "label", "scenarioHandleDigest", "approvalIdDigest", "checkpointDigest",
  "suspendedSessionRevisionDigest", "approvalEpochBefore", "callbackAttempts", "distinctQueryCount",
  "callbackDataDigest", "settledCount", "claimCount", "mutationCount", "staleAcknowledged", "promptTerminal",
]

const RESTART_RECEIPT_KEYS = [
  "schemaVersion", "phase", "label", "scenarioHandleDigest", "approvalIdDigest", "checkpointDigest",
  "suspendedSessionRevisionDigest", "approvalEpochBefore", "approvalEpochAfterRestart", "continuationEpochAfter",
  "ownerImageDigest", "ownerContainerDigest", "restartCountBefore", "restartCountAfter", "pendingDigestBefore",
  "pendingDigestAfter", "pendingRestored", "callbackAttempts", "mutationCount", "indeterminateRecoveryObserved",
  "attemptedRecoveryReopened", "attemptedRecordDigest", "recoveredRecordDigest", "indeterminateRetryCount",
]
const PREPARED_RESTART_RECEIPT_KEYS = [
  "schemaVersion", "phase", "label", "scenarioHandleDigest", "approvalIdDigest", "checkpointDigest",
  "suspendedSessionRevisionDigest", "approvalEpochBefore", "pendingDigestBefore", "indeterminateRecoveryObserved",
  "attemptedRecoveryReopened", "attemptedRecordDigest", "recoveredRecordDigest",
  "ownerImageDigest", "ownerContainerDigest", "restartCountBefore",
]

function requireInteractiveReceipt(receipt, input) {
  const value = object(receipt, "interactive driver receipt")
  const duplicate = input.label === "unit-16l-duplicate-callback"
  exactKeys(value, duplicate ? DUPLICATE_RECEIPT_KEYS : RESTART_RECEIPT_KEYS, "interactive driver receipt")
  if (value.schemaVersion !== "sanctuary-interactive-driver-receipt-v2" || value.phase !== "complete"
    || value.label !== input.label || value.scenarioHandleDigest !== input.scenarioHandleDigest
    || ![value.approvalIdDigest, value.checkpointDigest, value.suspendedSessionRevisionDigest].every((item) => typeof item === "string" && SHA256.test(item))
    || !Number.isSafeInteger(value.approvalEpochBefore) || value.approvalEpochBefore < 0) {
    throw new Error("interactive driver receipt is invalid")
  }
  if (duplicate) {
    if (!SHA256.test(value.callbackDataDigest) || value.callbackAttempts !== 2 || value.distinctQueryCount !== 2
      || value.barrierObserved !== true || value.settledCount !== 2 || value.claimCount !== 1 || value.mutationCount !== 1
      || value.staleReplayAttempts !== 1 || value.staleReplaySettled !== true || value.staleReplayMutationCount !== 0
      || value.promptTerminal !== true || value.writeCredentialObserved !== false) throw new Error("interactive driver receipt is invalid")
  } else if (!SHA256.test(value.ownerImageDigest) || !SHA256.test(value.ownerContainerDigest)
    || !SHA256.test(value.pendingDigestBefore) || value.pendingDigestAfter !== value.pendingDigestBefore
    || value.approvalEpochAfterRestart !== value.approvalEpochBefore || !Number.isSafeInteger(value.continuationEpochAfter)
    || value.continuationEpochAfter <= value.approvalEpochAfterRestart || !Number.isSafeInteger(value.restartCountBefore)
    || value.restartCountAfter !== value.restartCountBefore + 1 || value.pendingRestored !== true || value.callbackAttempts !== 1
    || value.mutationCount !== 1 || value.indeterminateRecoveryObserved !== true || value.attemptedRecoveryReopened !== true
    || !SHA256.test(value.attemptedRecordDigest) || !SHA256.test(value.recoveredRecordDigest)
    || value.attemptedRecordDigest === value.recoveredRecordDigest || value.indeterminateRetryCount !== 0) {
    throw new Error("interactive driver receipt is invalid")
  }
  return value
}

function requireTimeoutReceipt(receipt, input) {
  const value = object(receipt, "timeout stale driver receipt")
  exactKeys(value, TIMEOUT_RECEIPT_KEYS, "timeout stale driver receipt")
  if (value.schemaVersion !== "sanctuary-timeout-stale-driver-receipt-v1" || value.phase !== "complete"
    || value.label !== input.label || value.scenarioHandleDigest !== input.scenarioHandleDigest
    || ![value.approvalIdDigest, value.checkpointDigest, value.suspendedSessionRevisionDigest, value.callbackDataDigest]
      .every((item) => typeof item === "string" && SHA256.test(item))
    || !Number.isSafeInteger(value.approvalEpochBefore) || value.approvalEpochBefore < 0
    || value.callbackAttempts !== 1 || value.distinctQueryCount !== 1 || value.settledCount !== 1
    || value.claimCount !== 0 || value.mutationCount !== 0 || value.staleAcknowledged !== true || value.promptTerminal !== true) {
    throw new Error("timeout stale driver receipt is invalid")
  }
  return value
}

function requirePreparedRestartReceipt(receipt, input) {
  const value = object(receipt, "restart continuation prepared receipt")
  exactKeys(value, PREPARED_RESTART_RECEIPT_KEYS, "restart continuation prepared receipt")
  if (value.schemaVersion !== "sanctuary-interactive-driver-receipt-v2" || (value.phase !== "prepared" && value.phase !== "attempted_or_indeterminate")
    || value.label !== input.label || value.scenarioHandleDigest !== input.scenarioHandleDigest
    || ![value.approvalIdDigest, value.checkpointDigest, value.suspendedSessionRevisionDigest, value.pendingDigestBefore,
      value.ownerImageDigest, value.ownerContainerDigest, value.attemptedRecordDigest, value.recoveredRecordDigest].every((item) => typeof item === "string" && SHA256.test(item))
    || !Number.isSafeInteger(value.approvalEpochBefore) || value.approvalEpochBefore < 0 || value.indeterminateRecoveryObserved !== true
    || value.attemptedRecoveryReopened !== true || value.attemptedRecordDigest === value.recoveredRecordDigest
    || !Number.isSafeInteger(value.restartCountBefore) || value.restartCountBefore < 0) throw new Error("restart continuation prepared receipt is invalid")
  return value
}

function runInteractiveRuntimeOperation(operation, value, dependencies = { run: spawnSync }) {
  const result = dependencies.run(DOCKER, ["exec", "-i", activeContainerId, ACCEPTANCE_ADAPTER], {
    cwd: "/", encoding: "utf8", timeout: 120_000, maxBuffer: MAX_REQUEST,
    env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["pipe", "pipe", "ignore"],
    input: JSON.stringify({ operation, ...value }),
  })
  if (result.error || result.status !== 0) throw new Error("interactive production runtime driver failed")
  try { return object(JSON.parse(result.stdout ?? ""), "interactive driver receipt") } catch { throw new Error("interactive driver receipt is invalid") }
}

function runInteractiveDriver(input, dependencies = { run: spawnSync }) {
  const value = canonicalInteractiveRequest(input, "unit-16l-duplicate-callback")
  return requireInteractiveReceipt(runInteractiveRuntimeOperation("drive_duplicate_callbacks", value, dependencies), value)
}

function runTimeoutStaleDriver(input, dependencies = { run: spawnSync }) {
  const value = canonicalInteractiveRequest(input, "unit-16k-timeout-stale")
  const response = runInteractiveRuntimeOperation("drive_timeout_stale", value, dependencies)
  if (response.state === "waiting") {
    exactKeys(response, ["state"], "timeout stale waiting response")
    return response
  }
  return requireTimeoutReceipt(response, value)
}

async function restartButlerForAcceptance(input, dependencies = {
  snapshot: () => containerRestartSnapshot(expectedImageId), run: spawnSync,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  canonicalInteractiveRequest(input, "unit-16m-restart-continuation")
  const before = object(await dependencies.snapshot(), "restart owner before")
  const result = dependencies.run(DOCKER, ["restart", activeContainerId], {
    cwd: "/", encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024,
    env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "ignore", "ignore"],
  })
  if (result.error || result.status !== 0) throw new Error("production butler restart failed")
  const ownerImage = text(before.imageId, "restart owner image", IMAGE_ID)
  const ownerContainer = text(before.containerId, "restart owner container", SHA256)
  if (!Number.isSafeInteger(before.restartCount) || before.restartCount < 0) throw new Error("restart owner count is invalid")
  const beforeLifecycleDigest = createHash("sha256").update(JSON.stringify(before)).digest("hex")
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const after = object(await dependencies.snapshot(), "restart owner after")
    const afterLifecycleDigest = createHash("sha256").update(JSON.stringify(after)).digest("hex")
    if (after.running === true && after.health === "healthy" && after.containerId === ownerContainer && after.imageId === ownerImage
      && after.restartCount === before.restartCount + 1 && afterLifecycleDigest !== beforeLifecycleDigest) {
      return {
        restarted: true,
        beforeLifecycleDigest,
        afterLifecycleDigest,
        restartInvocationCount: 1,
        ownerImageDigest: ownerImage.slice(7), ownerContainerDigest: ownerContainer,
        restartCountBefore: before.restartCount, restartCountAfter: after.restartCount,
      }
    }
    await dependencies.sleep(1_000)
  }
  throw new Error("production butler did not return with exact restart identity")
}

function interactiveReceiptPath(scenarioHandleDigest) {
  return `${PRODUCTION_BUNDLE_SOURCE}/state/acceptance/interactive-driver-receipts/${scenarioHandleDigest}.json`
}

function readInteractiveReceipt(input) {
  const file = interactiveReceiptPath(input.scenarioHandleDigest)
  let fd
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) { if (error.code === "ENOENT") return null; throw error }
  try {
    const metadata = fstatSync(fd)
    if (!metadata.isFile() || metadata.uid !== 10001 || (metadata.mode & 0o777) !== 0o600 || metadata.size > MAX_REQUEST) throw new Error("interactive driver receipt metadata is invalid")
    return object(JSON.parse(readFileSync(fd, "utf8")), "interactive driver receipt")
  } finally { closeSync(fd) }
}

function persistInteractiveReceipt(input, receipt) {
  const root = `${PRODUCTION_BUNDLE_SOURCE}/state/acceptance/interactive-driver-receipts`
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chownSync(root, 10001, 10001)
  chmodSync(root, 0o700)
  const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const directoryMetadata = fstatSync(directory)
  if (!directoryMetadata.isDirectory() || directoryMetadata.uid !== 10001 || (directoryMetadata.mode & 0o777) !== 0o700) {
    closeSync(directory)
    throw new Error("interactive driver receipt directory metadata is invalid")
  }
  const file = interactiveReceiptPath(input.scenarioHandleDigest)
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { chownSync(temporary, 10001, 10001); writeFileSync(fd, `${JSON.stringify(receipt)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, file)
    fsyncSync(directory)
  } finally { closeSync(directory) }
}

async function driveDuplicateCallbacks(input, dependencies = {
  readReceipt: readInteractiveReceipt,
  persistReceipt: persistInteractiveReceipt,
  runtime: runInteractiveDriver,
}) {
  const value = canonicalInteractiveRequest(input, "unit-16l-duplicate-callback")
  const existing = dependencies.readReceipt(value)
  if (existing) {
    if (existing.phase === "complete") return requireInteractiveReceipt(existing, value)
    throw new Error("duplicate callback drive requires inspect-before-retry")
  }
  dependencies.persistReceipt(value, { schemaVersion: "sanctuary-interactive-driver-receipt-v2", phase: "attempting", ...value })
  try {
    const receipt = requireInteractiveReceipt(await dependencies.runtime(value), value)
    dependencies.persistReceipt(value, receipt)
    return receipt
  } catch (error) {
    dependencies.persistReceipt(value, { schemaVersion: "sanctuary-interactive-driver-receipt-v2", phase: "attempted_or_indeterminate", ...value })
    throw error
  }
}

async function driveTimeoutStale(input, dependencies = {
  readReceipt: readInteractiveReceipt,
  persistReceipt: persistInteractiveReceipt,
  runtime: runTimeoutStaleDriver,
}) {
  const value = canonicalInteractiveRequest(input, "unit-16k-timeout-stale")
  const existing = dependencies.readReceipt(value)
  if (existing?.phase === "complete") return requireTimeoutReceipt(existing, value)
  if (existing && existing.phase !== "waiting") throw new Error("timeout stale drive requires inspect-before-retry")
  dependencies.persistReceipt(value, {
    schemaVersion: "sanctuary-timeout-stale-driver-receipt-v1",
    phase: existing ? "attempting" : "preparing",
    ...value,
  })
  try {
    const response = await dependencies.runtime(value)
    if (response.state === "waiting") {
      exactKeys(response, ["state"], "timeout stale waiting response")
      dependencies.persistReceipt(value, { schemaVersion: "sanctuary-timeout-stale-driver-receipt-v1", phase: "waiting", ...value })
      return response
    }
    const receipt = requireTimeoutReceipt(response, value)
    dependencies.persistReceipt(value, receipt)
    return receipt
  } catch (error) {
    dependencies.persistReceipt(value, {
      schemaVersion: "sanctuary-timeout-stale-driver-receipt-v1",
      phase: existing ? "attempted_or_indeterminate" : "preparation_indeterminate",
      ...value,
    })
    throw error
  }
}

async function driveRestartContinuation(input, dependencies = {
  readReceipt: readInteractiveReceipt,
  persistReceipt: persistInteractiveReceipt,
  runtime: runInteractiveRuntimeOperation,
  restart: restartButlerForAcceptance,
  snapshot: () => containerRestartSnapshot(expectedImageId),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const value = canonicalInteractiveRequest(input, "unit-16m-restart-continuation")
  const existing = dependencies.readReceipt(value)
  if (existing) {
    if (existing.phase === "complete") return requireInteractiveReceipt(existing, value)
    let recoverable
    try { recoverable = requirePreparedRestartReceipt(existing, value) } catch { throw new Error("restart continuation requires inspect-before-retry") }
    const observed = object(await dependencies.snapshot(), "restart continuation recovery owner")
    if (observed.imageId !== `sha256:${recoverable.ownerImageDigest}` || observed.containerId !== recoverable.ownerContainerDigest
      || observed.running !== true || observed.health !== "healthy" || observed.restartCount !== recoverable.restartCountBefore + 1) {
      throw new Error("restart continuation requires inspect-before-retry")
    }
    await waitForInteractiveRuntimeReady(value, dependencies)
    const reconciled = object(await dependencies.runtime("reconcile_restart_continuation", value), "restart continuation reconciliation")
    const receipt = { ...recoverable, ...reconciled, phase: "complete", restartCountAfter: observed.restartCount }
    delete receipt.restarted
    requireInteractiveReceipt(receipt, value)
    dependencies.persistReceipt(value, receipt)
    return receipt
  }
  const attempting = { schemaVersion: "sanctuary-interactive-driver-receipt-v2", phase: "attempting", ...value }
  dependencies.persistReceipt(value, attempting)
  let prepared
  try {
    prepared = object(await dependencies.runtime("prepare_restart_continuation", value), "restart continuation prepared receipt")
    const expected = ["schemaVersion", "phase", "label", "scenarioHandleDigest", "approvalIdDigest", "checkpointDigest", "suspendedSessionRevisionDigest", "approvalEpochBefore", "pendingDigestBefore", "indeterminateRecoveryObserved", "attemptedRecoveryReopened", "attemptedRecordDigest", "recoveredRecordDigest"]
    exactKeys(prepared, expected, "restart continuation prepared receipt")
    if (prepared.schemaVersion !== "sanctuary-interactive-driver-receipt-v2" || prepared.phase !== "prepared" || prepared.label !== value.label
      || prepared.scenarioHandleDigest !== value.scenarioHandleDigest || ![prepared.approvalIdDigest, prepared.checkpointDigest, prepared.suspendedSessionRevisionDigest, prepared.pendingDigestBefore].every((item) => typeof item === "string" && SHA256.test(item))
      || !Number.isSafeInteger(prepared.approvalEpochBefore) || prepared.approvalEpochBefore < 0 || prepared.indeterminateRecoveryObserved !== true
      || prepared.attemptedRecoveryReopened !== true || !SHA256.test(prepared.attemptedRecordDigest) || !SHA256.test(prepared.recoveredRecordDigest)
      || prepared.attemptedRecordDigest === prepared.recoveredRecordDigest) throw new Error("restart continuation prepared receipt is invalid")
    const ownerBefore = object(await dependencies.snapshot(), "restart continuation owner before")
    if (!IMAGE_ID.test(ownerBefore.imageId) || !SHA256.test(ownerBefore.containerId) || ownerBefore.running !== true || ownerBefore.health !== "healthy"
      || !Number.isSafeInteger(ownerBefore.restartCount) || ownerBefore.restartCount < 0) throw new Error("restart continuation owner before is invalid")
    prepared = { ...prepared, ownerImageDigest: ownerBefore.imageId.slice(7), ownerContainerDigest: ownerBefore.containerId, restartCountBefore: ownerBefore.restartCount }
    dependencies.persistReceipt(value, prepared)
    const restarted = object(await dependencies.restart(value), "restart continuation owner restart")
    if (restarted.restarted !== true || restarted.restartInvocationCount !== 1 || !SHA256.test(restarted.ownerImageDigest) || !SHA256.test(restarted.ownerContainerDigest)
      || restarted.ownerImageDigest !== prepared.ownerImageDigest || restarted.ownerContainerDigest !== prepared.ownerContainerDigest
      || restarted.restartCountBefore !== prepared.restartCountBefore || restarted.restartCountAfter !== restarted.restartCountBefore + 1) throw new Error("restart continuation owner restart is invalid")
    await waitForInteractiveRuntimeReady(value, dependencies)
    const reconciled = object(await dependencies.runtime("reconcile_restart_continuation", value), "restart continuation reconciliation")
    const receipt = { ...prepared, ...reconciled, phase: "complete", ownerImageDigest: restarted.ownerImageDigest, ownerContainerDigest: restarted.ownerContainerDigest, restartCountBefore: restarted.restartCountBefore, restartCountAfter: restarted.restartCountAfter }
    requireInteractiveReceipt(receipt, value)
    dependencies.persistReceipt(value, receipt)
    return receipt
  } catch (error) {
    dependencies.persistReceipt(value, { ...(prepared ?? { schemaVersion: "sanctuary-interactive-driver-receipt-v2", ...value }), phase: "attempted_or_indeterminate" })
    throw error
  }
}

async function dispatch(request, dependencies = {
  readBootId: () => readFileSync(BOOT_ID, "utf8"),
  containerSnapshot: () => containerSnapshot(expectedImageId),
  denialTargetSnapshot,
  containerOwnerSnapshot: () => containerOwnerSnapshot(expectedImageId),
  startHealthProbe,
  healthProbeStatus,
  recoverHealthProbe,
  healthProbeCoordinator,
  driveTimeoutStale,
  driveDuplicateCallbacks,
  driveRestartContinuation,
  ownerMutationCoordinator,
  interactiveRestartDriver,
  healthOwnerMutationActive,
  liveContainerProcessUser,
  liveContainerProcessIdentity,
  parseProcStartTime,
  productionProcessBindingDigest,
  rebootPreflightSnapshot: observeRebootPreflight,
  stopExactRebootOwner,
  verifyStoppedRebootOwner,
  commitHostReboot: () => new Promise((resolve, reject) => {
    const child = spawn(REBOOT, [], { cwd: "/", detached: true, stdio: "ignore", env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" } })
    child.once("error", reject)
    child.once("spawn", () => { child.unref(); resolve() })
  }),
}) {
  const payload = object(request, "broker request")
  const operation = text(payload.operation, "operation")
  if (operation === "inventory_keys") {
    exactKeys(payload, ["operation", "targetServerId"], operation)
    if (payload.targetServerId !== TARGET_SERVER) throw new Error("target server is invalid")
    return { keys: inventoryRecords().map(publicRecord) }
  }
  if (operation === "read_key_record") {
    exactKeys(payload, ["operation", "targetServerId", "keyId"], operation)
    if (payload.targetServerId !== TARGET_SERVER) throw new Error("target server is invalid")
    const id = text(payload.keyId, "key id", KEY_ID)
    const matches = inventoryRecords().filter((record) => record.id === id)
    if (matches.length !== 1) throw new Error("exact key id is absent or ambiguous")
    return matches[0]
  }
  if (operation === "create_key") {
    exactKeys(payload, ["operation", "targetServerId", "name", "permissions"], operation)
    if (payload.targetServerId !== TARGET_SERVER) throw new Error("target server is invalid")
    const name = text(payload.name, "key name", KEY_NAME)
    const requested = permissions(payload.permissions)
    const created = runUnraid(["apikey", "--name", name, "--create", "--permissions", requested.join(","), "--json"])
    const id = text(created.id, "created key id", KEY_ID)
    const key = text(created.key, "created key descriptor")
    const actualPermissions = permissions(created.permissions)
    if (created.name !== name || JSON.stringify(actualPermissions) !== JSON.stringify(requested)
      || !Array.isArray(created.roles) || created.roles.length !== 0) throw new Error("created key identity is invalid")
    const matches = inventoryRecords().filter((record) => record.id === id)
    if (matches.length !== 1 || matches[0].name !== name || matches[0].key !== key
      || JSON.stringify(flattened(matches[0])) !== JSON.stringify(requested) || matches[0].roles.length !== 0) {
      throw new Error("created key record does not match the exact CLI result")
    }
    return matches[0]
  }
  if (operation === "revoke_key") {
    exactKeys(payload, ["operation", "targetServerId", "keyId"], operation)
    if (payload.targetServerId !== TARGET_SERVER) throw new Error("target server is invalid")
    const id = text(payload.keyId, "key id", KEY_ID)
    const matches = inventoryRecords().filter((record) => record.id === id)
    if (matches.length !== 1) throw new Error("exact key id is absent or ambiguous")
    const record = matches[0]
    persistRecovery(record)
    const deleted = runUnraid(["apikey", "--name", record.name, "--delete", "--json"])
    if (deleted.deleted !== 1 || !Array.isArray(deleted.keys) || deleted.keys.length !== 1
      || deleted.keys[0]?.id !== id || deleted.keys[0]?.name !== record.name) throw new Error("exact key revoke attestation failed")
    return { revoked: true, id }
  }
  if (operation === "probe_revoked_key") {
    exactKeys(payload, ["operation", "targetServerId", "keyId"], operation)
    if (payload.targetServerId !== TARGET_SERVER) throw new Error("target server is invalid")
    const id = text(payload.keyId, "key id", KEY_ID)
    const record = normalizeRecord(readPrivateJson(recoveryPath(id)))
    if (record.id !== id) throw new Error("recovery key id is invalid")
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": record.key },
      body: JSON.stringify({ query: "query AcceptanceAuthProbe { info { os { hostname } } }", variables: {} }),
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status !== 401 && response.status !== 403) throw new Error("revoked key still authenticates")
    removeRecovery(id)
    return { valid: false, status: response.status, id }
  }
  if (operation === "request_reboot") {
    exactKeys(payload, ["operation", "targetId", "idempotencyKey", "preflightDigest", "processBindingDigest"], operation)
    if (payload.targetId !== TARGET_HOST) throw new Error("target host is invalid")
    const key = text(payload.idempotencyKey, "idempotency key", /^[0-9a-f]{32}$/u)
    const preflightDigest = text(payload.preflightDigest, "preflight digest", SHA256)
    const processBindingDigest = text(payload.processBindingDigest, "process binding digest", SHA256)
    const requestId = createHash("sha256").update(`sanctuary-reboot\0${key}`).digest("hex")
    const reservationId = createHash("sha256").update(`sanctuary-reboot-reservation\0${requestId}`).digest("hex")
    const reserve = dependencies.ownerMutationCoordinator?.reserveReboot
    if (!reserve) throw new Error("reboot reservation coordinator is unavailable")
    await reserve.call(dependencies.ownerMutationCoordinator, reservationId, processBindingDigest, async () => {
      const preflight = object(dependencies.rebootPreflightSnapshot(), "reboot preflight")
      if (preflight.digest !== preflightDigest) throw new Error("reboot preflight changed before commit")
      if (preflight.safe !== true) throw new Error("reboot preflight is unsafe")
      const owner = object(await dependencies.containerSnapshot(), "reboot reservation production owner")
      if (owner.processBindingDigest !== processBindingDigest) throw new Error("production process generation changed before reboot reservation")
    })
    const prebootId = text(dependencies.readBootId().trim(), "boot id", /^[A-Za-z0-9-]{4,128}$/u)
    return { accepted: true, targetId: TARGET_HOST, requestId, reservationId, prebootId, preflightDigest, processBindingDigest, staged: true }
  }
  if (operation === "stop_reboot_owner") {
    exactKeys(payload, ["operation", "targetId", "requestId", "reservationId", "processBindingDigest"], operation)
    if (payload.targetId !== TARGET_HOST) throw new Error("target host is invalid")
    const requestId = text(payload.requestId, "reboot request id", SHA256)
    const reservationId = text(payload.reservationId, "reboot reservation", SHA256)
    const processBindingDigest = text(payload.processBindingDigest, "process binding digest", SHA256)
    if (reservationId !== createHash("sha256").update(`sanctuary-reboot-reservation\0${requestId}`).digest("hex")) throw new Error("reboot request reservation binding is invalid")
    const stop = dependencies.ownerMutationCoordinator?.stopRebootOwner
    if (!stop || !dependencies.stopExactRebootOwner) throw new Error("exact reboot owner stop is unavailable")
    await stop.call(dependencies.ownerMutationCoordinator, reservationId, processBindingDigest, () => dependencies.stopExactRebootOwner(processBindingDigest))
    return { stopped: true, targetId: TARGET_HOST, requestId, reservationId, processBindingDigest }
  }
  if (operation === "commit_reboot") {
    exactKeys(payload, ["operation", "targetId", "requestId", "reservationId", "processBindingDigest"], operation)
    if (payload.targetId !== TARGET_HOST) throw new Error("target host is invalid")
    const requestId = text(payload.requestId, "reboot request id", SHA256)
    const reservationId = text(payload.reservationId, "reboot reservation", SHA256)
    const processBindingDigest = text(payload.processBindingDigest, "process binding digest", SHA256)
    if (reservationId !== createHash("sha256").update(`sanctuary-reboot-reservation\0${requestId}`).digest("hex")) throw new Error("reboot request reservation binding is invalid")
    const commit = dependencies.ownerMutationCoordinator?.commitReboot
    if (!commit) throw new Error("reboot reservation coordinator is unavailable")
    await commit.call(dependencies.ownerMutationCoordinator, reservationId, processBindingDigest, async (stoppedProof, markAttempted) => {
      await dependencies.verifyStoppedRebootOwner(stoppedProof)
      const preflight = object(dependencies.rebootPreflightSnapshot(), "final reboot preflight")
      if (preflight.safe !== true || preflight.arrayReady !== true || preflight.parityActive !== false || preflight.moverActive !== false || preflight.mutationActive !== false) {
        throw new Error("final reboot preflight is unsafe")
      }
      await dependencies.verifyStoppedRebootOwner(stoppedProof)
      markAttempted()
      await dependencies.commitHostReboot()
    })
    return { committed: true, targetId: TARGET_HOST, requestId, reservationId, processBindingDigest }
  }
  if (operation === "reboot_preflight_snapshot") {
    exactKeys(payload, ["operation", "targetId", "processBindingDigest"], operation)
    if (payload.targetId !== TARGET_HOST) throw new Error("target host is invalid")
    const processBindingDigest = text(payload.processBindingDigest, "process binding digest", SHA256)
    const owner = object(await dependencies.containerSnapshot(), "reboot preflight production owner")
    if (owner.processBindingDigest !== processBindingDigest) throw new Error("production process generation changed before reboot preflight")
    return { ...dependencies.rebootPreflightSnapshot(), processBindingDigest }
  }
  if (operation === "container_snapshot") {
    exactKeys(payload, ["operation", "targetId"], operation)
    if (payload.targetId !== TARGET_HOST) throw new Error("target host is invalid")
    return await dependencies.containerSnapshot()
  }
  if (operation === "denial_target_snapshot") {
    exactKeys(payload, ["operation", "targetId"], operation)
    if (payload.targetId !== TARGET_HOST) throw new Error("target host is invalid")
    if (!dependencies.denialTargetSnapshot) throw new Error("denial target snapshot is unavailable")
    return await dependencies.denialTargetSnapshot()
  }
  if (operation === "start_health_probe" || operation === "health_probe_status" || operation === "recover_health_probe") {
    exactKeys(payload, ["operation", "targetId", "label", "scenarioHandleDigest"], operation)
    if (payload.targetId !== TARGET_HOST) throw new Error("target host is invalid")
    const request = canonicalHealthProbeRequest({ label: payload.label, scenarioHandleDigest: payload.scenarioHandleDigest })
    if (operation === "start_health_probe") {
      const start = async () => {
        const snapshot = object(await dependencies.containerSnapshot(), "health probe production owner")
        if (snapshot.running !== true || snapshot.health !== "healthy") throw new Error("health probe requires a healthy production owner")
        const coordinates = healthProbeCoordinates(payload, snapshot)
        if (!dependencies.startHealthProbe) throw new Error("health probe start is unavailable")
        return await dependencies.startHealthProbe(coordinates)
      }
      if (dependencies.ownerMutationCoordinator) return await dependencies.ownerMutationCoordinator.healthStart(request.scenarioHandleDigest, start)
      return dependencies.healthProbeCoordinator ? await dependencies.healthProbeCoordinator.start(request.scenarioHandleDigest, start) : await start()
    }
    if (operation === "health_probe_status") {
      if (!dependencies.healthProbeStatus) throw new Error("health probe status is unavailable")
      const status = () => dependencies.healthProbeStatus(request)
      return dependencies.ownerMutationCoordinator ? await dependencies.ownerMutationCoordinator.healthOperation(request.scenarioHandleDigest, status) : await status()
    }
    const recover = async () => {
      if (!dependencies.recoverHealthProbe) throw new Error("health probe recovery is unavailable")
      const ownerSnapshot = object(await (dependencies.containerOwnerSnapshot ?? dependencies.containerSnapshot)(), "health probe production owner")
      const coordinates = healthProbeCoordinates(payload, ownerSnapshot)
      return await dependencies.recoverHealthProbe(coordinates)
    }
    if (dependencies.ownerMutationCoordinator) return await dependencies.ownerMutationCoordinator.healthRecover(request.scenarioHandleDigest, recover)
    return dependencies.healthProbeCoordinator ? await dependencies.healthProbeCoordinator.recover(request.scenarioHandleDigest, recover) : await recover()
  }
  if (operation === "drive_timeout_stale" || operation === "drive_duplicate_callbacks" || operation === "drive_restart_continuation") {
    exactKeys(payload, ["operation", "targetId", "label", "scenarioHandleDigest"], operation)
    if (payload.targetId !== TARGET_HOST) throw new Error("target host is invalid")
    const expectedLabel = operation === "drive_timeout_stale" ? "unit-16k-timeout-stale"
      : operation === "drive_duplicate_callbacks" ? "unit-16l-duplicate-callback" : "unit-16m-restart-continuation"
    const input = canonicalInteractiveRequest({ label: payload.label, scenarioHandleDigest: payload.scenarioHandleDigest }, expectedLabel)
    if (dependencies.healthOwnerMutationActive?.()) throw new Error("owner mutation refused while durable health probe artifacts are active")
    const drive = operation === "drive_timeout_stale" ? dependencies.driveTimeoutStale
      : operation === "drive_duplicate_callbacks" ? dependencies.driveDuplicateCallbacks : dependencies.driveRestartContinuation
    if (!drive) throw new Error("interactive production runtime driver is unavailable")
    const execute = async () => operation === "drive_timeout_stale"
      ? await drive(input)
      : requireInteractiveReceipt(await drive(input), input)
    if (operation === "drive_restart_continuation") {
      if (!dependencies.interactiveRestartDriver) throw new Error("interactive restart driver is unavailable")
      const owned = () => dependencies.ownerMutationCoordinator ? dependencies.ownerMutationCoordinator.interactive(execute) : execute()
      const response = dependencies.interactiveRestartDriver.poll(input, owned)
      if (response.state === "waiting") Object.defineProperty(response, ASYNC_RESTART_SCENARIO, { value: input.scenarioHandleDigest })
      return response
    }
    return dependencies.ownerMutationCoordinator ? await dependencies.ownerMutationCoordinator.interactive(execute) : await execute()
  }
  throw new Error("host broker operation is not whitelisted")
}

function writeClosedInventory(file) {
  const value = { keys: inventoryRecords().map(publicRecord) }
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
  chownSync(file, 0, 0)
}

async function main() {
  if (process.getuid?.() !== 0) throw new Error("host broker must run as root")
  const [profileName, targetContainerId, socket, closedInventory, expectedImage, initialSnapshot] = process.argv.slice(2)
  if (!profileName || !targetContainerId || !socket || !closedInventory || !expectedImage || !initialSnapshot || process.argv.length !== 8) throw new Error("usage: broker <staging|final> <target-container-id> <socket> <closed-inventory> <expected-image-id> <initial-snapshot>")
  activeProfile = targetProfile(profileName)
  activeContainer = activeProfile.containerName
  activeContainerId = text(targetContainerId, "attested target container id", SHA256)
  expectedImageId = text(expectedImage, "expected image id", IMAGE_ID)
  rmSync(socket, { force: true })
  writeClosedInventory(closedInventory)
  const snapshot = await containerSnapshot(expectedImageId)
  const snapshotFd = openSync(initialSnapshot, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try { writeFileSync(snapshotFd, `${JSON.stringify(snapshot)}\n`); fsyncSync(snapshotFd) } finally { closeSync(snapshotFd) }
  chownSync(initialSnapshot, 0, 0)
  const server = createServer((connection) => {
    let input = ""
    connection.setEncoding("utf8")
    connection.on("data", (chunk) => {
      input += chunk
      if (Buffer.byteLength(input) > MAX_REQUEST) connection.destroy()
    })
    connection.on("end", async () => {
      try {
        const result = await dispatchDrain.run(() => dispatch(JSON.parse(input)))
        const scenario = result?.[ASYNC_RESTART_SCENARIO]
        const completed = scenario ? armRestartAfterResponseClosed(connection, scenario) : undefined
        connection.end(`${JSON.stringify({ ok: true, result })}\n`, completed)
      } catch { connection.end(`${JSON.stringify({ ok: false, error: "host operation failed" })}\n`) }
    })
  })
  const dispatchDrain = createDispatchDrain()
  server.listen(socket, () => {
    chownSync(socket, 0, 10001)
    chmodSync(socket, 0o660)
  })
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    server.close()
    await dispatchDrain.stopAndDrain()
    await interactiveRestartDriver.stopAndDrain()
    let failed = false
    for (const record of [...activeHealthProbes.values()]) {
      try { await recoverHealthProbe(record.input) } catch { failed = true }
    }
    process.exitCode = failed ? 1 : 0
  }
  process.once("SIGTERM", () => { void shutdown() })
  process.once("SIGINT", () => { void shutdown() })
}

if (process.argv[1]?.endsWith("sanctuary-unit16-host-broker.mjs")) {
  main().catch(() => { process.exitCode = 1 })
}

export {
  assertStableContainerProcess,
  attestHealthProbeProcessAbsent,
  armRestartAfterResponseClosed,
  completeHealthProbeFromReceipt,
  createDispatchDrain,
  createHealthProbeOperationCoordinator,
  createOwnerMutationCoordinator,
  createInteractiveRestartDriver,
  dispatch,
  denialTargetSnapshot,
  healthProbeArtifactDisposition,
  healthProbeDockerArgs,
  healthProbeOperationBudgets,
  finalizeHealthProbeAfterAttestation,
  healthOwnerMutationActive,
  liveContainerProcessUser,
  liveContainerProcessIdentity,
  parseProcStartTime,
  productionProcessBindingDigest,
  observeRebootPreflight,
  parseVaultStatus,
  optionalStoppedContainerExact,
  queryGraphqlAutostart,
  readBoundedProcStatus,
  driveDuplicateCallbacks,
  driveTimeoutStale,
  driveRestartContinuation,
  restartButlerForAcceptance,
  runInteractiveDriver,
  recoverAfterHealthProbeTermination,
  requireStableHealthProbeOwner,
  requireHealthProbeCompleteAttestation,
  terminateHealthProbeChild,
}
