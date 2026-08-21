#!/usr/local/bin/node

import { spawn, spawnSync } from "node:child_process"
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const DOCKER = "/usr/bin/docker"
const KEY_ROOT = "/boot/config/plugins/dynamix.my.servers/keys"
const GRAPHQL_ENDPOINT = "http://127.0.0.1/graphql"
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u
const CONTAINER_ID = /^[0-9a-f]{64}$/u
const CANONICAL_NAMES = ["ouro-butler", "ouro-butler-staging", "ouro-butler-rollback"]
const PROFILES = Object.freeze({
  staging: Object.freeze({ name: "staging", containerName: "ouro-butler-staging", requiredStopped: [], forbidden: ["ouro-butler", "ouro-butler-rollback"] }),
  final: Object.freeze({ name: "final", containerName: "ouro-butler", requiredStopped: ["ouro-butler-rollback"], forbidden: ["ouro-butler-staging"] }),
})
const DOCUMENTED_UNIX_CONTROLS = [
  "/tmp/ouroboros-daemon.sock",
  "/home/ouro/AgentBundles/sanctuary.ouro/state/acceptance/telegram-control.sock",
]
const DOCUMENTED_LOOPBACK_TCP_CONTROLS = new Set([6876])
const TERMINAL_CONTAINMENT_MAX_SAMPLES = 8
const TARGET_THAW_MAX_ATTEMPTS = 3
const WATCHDOG_POLL_MS = 100
const WATCHDOG_PARENT_DEATH_ENFORCEMENT_MS = 25_000
const RO_PERMISSIONS = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
  .map((resource) => `${resource}:READ_ANY`).sort()

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function targetProfile(name) {
  const profile = PROFILES[name]
  if (!profile) throw new Error("deployment target profile is invalid")
  return profile
}

function exactSet(left, right) {
  return left.size === right.size && [...left].every((entry) => right.has(entry))
}

function readCanonicalReadDescriptor() {
  const root = statSync(KEY_ROOT)
  if (!root.isDirectory() || root.uid !== 0 || (root.mode & 0o077) !== 0) throw new Error("Unraid key directory metadata is invalid")
  const matches = []
  for (const entry of readdirSync(KEY_ROOT, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) throw new Error("unexpected Unraid key directory entry")
    const fd = openSync(`${KEY_ROOT}/${entry.name}`, constants.O_RDONLY | constants.O_NOFOLLOW)
    let record
    try {
      const metadata = fstatSync(fd)
      if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o777) !== 0o600) throw new Error("Unraid key file metadata is invalid")
      record = object(JSON.parse(readFileSync(fd, "utf8")), "Unraid key record")
    } finally { closeSync(fd) }
    const permissions = Array.isArray(record.permissions)
      ? record.permissions.flatMap((raw) => {
        const permission = object(raw, "Unraid key permission")
        return Array.isArray(permission.actions) ? permission.actions.map((action) => `${permission.resource}:${action}`) : []
      }).sort()
      : []
    if (record.name === "Butler RO" && Array.isArray(record.roles) && record.roles.length === 0 && JSON.stringify(permissions) === JSON.stringify(RO_PERMISSIONS) && typeof record.key === "string" && record.key) matches.push(record.key)
  }
  if (matches.length !== 1) throw new Error("canonical read-only Unraid key is absent or ambiguous")
  return matches[0]
}

async function queryGraphqlAutostart(fetchImpl = fetch, readDescriptor = readCanonicalReadDescriptor) {
  const response = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": readDescriptor() },
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
  const result = new Map()
  for (const raw of containers) {
    const container = object(raw, "Unraid topology container")
    if (!Array.isArray(container.names) || container.names.some((name) => typeof name !== "string")) throw new Error("Unraid container topology identity is invalid")
    const canonical = container.names.map((name) => name.replace(/^\//u, "")).filter((name) => CANONICAL_NAMES.includes(name))
    const identity = typeof container.id === "string" ? /^([0-9a-f]{64}):([0-9a-f]{64})$/u.exec(container.id) : null
    if (canonical.length > 1 || (canonical.length === 1 && (!identity || identity[1] !== serverIdentity[1]))) throw new Error("Unraid container topology identity is ambiguous or belongs to another server")
    if (canonical.length === 1 && typeof container.autoStart !== "boolean") throw new Error("Unraid container autostart state is invalid")
    if (canonical.length === 1) {
      if (result.has(canonical[0])) throw new Error("Unraid autostart topology is ambiguous")
      result.set(canonical[0], { containerId: identity[2], autoStart: container.autoStart })
    }
  }
  return result
}

function normalizeRecord(raw, label) {
  const value = object(raw, label)
  if (!CONTAINER_ID.test(value.id) || !Array.isArray(value.names) || value.names.length !== 1 || typeof value.names[0] !== "string") throw new Error(`${label} identity is invalid`)
  const name = value.names[0].replace(/^\//u, "")
  if (!CANONICAL_NAMES.includes(name)) throw new Error(`${label} name is not canonical`)
  if (!IMAGE_ID.test(value.imageId) || typeof value.running !== "boolean" || typeof value.autoStart !== "boolean" || value.restartPolicy !== "unless-stopped" || value.networkMode !== "host") throw new Error(`${label} effective configuration is invalid`)
  if (!Number.isSafeInteger(value.pid) || value.pid < 0 || value.running !== (value.pid > 0)) throw new Error(`${label} PID state is invalid`)
  return { id: value.id, name, imageId: value.imageId, running: value.running, autoStart: value.autoStart, restartPolicy: value.restartPolicy, networkMode: value.networkMode, pid: value.pid }
}

function records(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const normalized = value.map((entry, index) => normalizeRecord(entry, `${label}[${index}]`))
  if (new Set(normalized.map(({ name }) => name)).size !== normalized.length || new Set(normalized.map(({ id }) => id)).size !== normalized.length) throw new Error(`${label} is duplicate or ambiguous`)
  return normalized.sort((left, right) => left.name.localeCompare(right.name))
}

function signature(value) {
  return JSON.stringify(value.map(({ id, name, imageId, running, autoStart, restartPolicy, networkMode, pid }) => ({ id, name, imageId, running, autoStart, restartPolicy, networkMode, pid })))
}

function attestDeploymentTarget(input) {
  const value = object(input, "deployment target input")
  const profile = targetProfile(value.profile)
  if (!IMAGE_ID.test(value.expectedImageId)) throw new Error("expected image ID is invalid")
  const before = records(value.topologyBefore, "topology before")
  const inspected = records(value.inspected, "canonical inspections")
  const after = records(value.topologyAfter, "topology after")
  if (signature(before) !== signature(after) || signature(before) !== signature(inspected)) throw new Error("canonical deployment topology changed or was incompletely inspected")
  const byName = new Map(inspected.map((entry) => [entry.name, entry]))
  const target = byName.get(profile.containerName)
  if (!target || target.imageId !== value.expectedImageId || !target.running || !target.autoStart) throw new Error("deployment target identity, image, state, or autostart is invalid")
  for (const name of profile.requiredStopped) {
    const stopped = byName.get(name)
    if (!stopped || stopped.running || stopped.autoStart) throw new Error("required rollback target state is invalid")
  }
  for (const name of profile.forbidden) if (byName.has(name)) throw new Error("mixed deployment target state is invalid")
  const activeRunningCardinality = inspected.filter(({ running }) => running).length
  if (activeRunningCardinality !== 1) throw new Error("active Butler running cardinality must equal one")
  return { schemaVersion: "sanctuary-deployment-target-v1", profile: profile.name, targetContainerName: profile.containerName, targetContainerId: target.id, targetImageId: target.imageId, targetPid: target.pid, activeRunningCardinality }
}

function attestOwnedListeners(input) {
  const value = object(input, "listener ownership input")
  if (!Number.isSafeInteger(value.rootPid) || value.rootPid <= 0 || !/^net:\[[0-9]+\]$/u.test(value.netnsBefore) || value.netnsBefore !== value.netnsAfter) throw new Error("target network namespace is invalid or changed")
  const processIdsBefore = value.processIdsBefore
  const processIdsAfter = value.processIdsAfter
  const validProcesses = (pids) => Array.isArray(pids) && pids.length > 0 && pids.includes(value.rootPid) && pids.every((pid) => Number.isSafeInteger(pid) && pid > 0) && new Set(pids).size === pids.length
  if (!validProcesses(processIdsBefore) || !validProcesses(processIdsAfter) || JSON.stringify([...processIdsBefore].sort((a, b) => a - b)) !== JSON.stringify([...processIdsAfter].sort((a, b) => a - b))) throw new Error("target cgroup process membership changed or is invalid")
  const socketSet = (raw, label) => {
    if (!Array.isArray(raw) || raw.some((inode) => !/^[0-9]+$/u.test(inode))) throw new Error(`${label} is invalid`)
    return new Set(raw)
  }
  const inventory = (suffix) => {
    const owned = socketSet(value[`socketInodes${suffix}`], `socket ownership ${suffix.toLowerCase()}`)
    const select = (kind, fallback) => value[kind] ?? value[`${fallback}${suffix}`]
    const tcpRaw = select("tcpListeners", "tcpListeners")
    const udpRaw = select("udpListeners", "udpListeners")
    const unixRaw = select("unixSockets", "unixSockets")
    if (!Array.isArray(tcpRaw) || !Array.isArray(udpRaw) || !Array.isArray(unixRaw)) throw new Error("listener inventory is invalid")
    const tcp = tcpRaw.filter((raw) => owned.has(object(raw, "TCP listener").inode))
    const udp = udpRaw.filter((raw) => owned.has(object(raw, "UDP listener").inode))
    const unix = unixRaw.filter((raw) => owned.has(object(raw, "Unix socket").inode))
    const sortRecords = (records) => [...records].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    const signature = JSON.stringify({ tcp: sortRecords(tcp), udp: sortRecords(udp), unix: sortRecords(unix) })
    return { owned, tcp, udp, unix, signature }
  }
  const before = inventory("Before")
  const after = inventory("After")
  const terminalFields = ["socketInodesTerminal", "tcpListenersTerminal", "udpListenersTerminal", "unixSocketsTerminal"]
  const providedTerminalFields = terminalFields.filter((field) => value[field] !== undefined)
  if (providedTerminalFields.length !== 0 && providedTerminalFields.length !== terminalFields.length) throw new Error("terminal listener inventory is incomplete")
  const terminal = providedTerminalFields.length === terminalFields.length ? inventory("Terminal") : after
  if (!exactSet(before.owned, after.owned) || !exactSet(after.owned, terminal.owned)) throw new Error("target socket ownership changed")
  if (before.signature !== after.signature || after.signature !== terminal.signature) throw new Error("target listener inventory changed")
  const { owned, tcp, udp, unix } = terminal
  for (const listener of tcp) {
    if (listener.localAddress !== "127.0.0.1" || !DOCUMENTED_LOOPBACK_TCP_CONTROLS.has(listener.port)) throw new Error("target runtime owns an inbound TCP listener")
  }
  if (udp.length !== 0) throw new Error("target runtime owns an inbound UDP listener")
  let unixControlSocketCount = 0
  for (const socket of unix) {
    if (socket.path === "" && socket.flags !== "00010000") continue
    if (!DOCUMENTED_UNIX_CONTROLS.includes(socket.path) || socket.flags !== "00010000" || socket.type !== "0001" || socket.state !== "01") throw new Error("target runtime owns an undocumented Unix endpoint")
    unixControlSocketCount += 1
  }
  return { schemaVersion: "sanctuary-listener-containment-v1", targetRootPid: value.rootPid, networkNamespace: value.netnsBefore, processCount: processIdsAfter.length, ownedSocketCount: owned.size, inboundTcpListenerCount: 0, inboundUdpListenerCount: 0, loopbackTcpControlCount: tcp.length, unixControlSocketCount }
}

function runDocker(args, timeoutMs = 20_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 20_000) throw new Error("Docker command timeout is invalid")
  const result = spawnSync(DOCKER, args, { cwd: "/", encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "pipe", "ignore"] })
  if (result.error || result.status !== 0) throw new Error("bounded deployment target inspection failed")
  return result.stdout
}

function pausedTargetState(target, run, timeoutMs = 20_000) {
  const template = '{"containerId":{{json .Id}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"restarting":{{json .State.Restarting}},"dead":{{json .State.Dead}},"pid":{{json .State.Pid}}}'
  const state = object(JSON.parse(run(["inspect", "--format", template, target.targetContainerId], timeoutMs)), "target pause state")
  if (!CONTAINER_ID.test(state.containerId) || typeof state.running !== "boolean" || typeof state.paused !== "boolean"
    || typeof state.restarting !== "boolean" || typeof state.dead !== "boolean" || !Number.isSafeInteger(state.pid) || state.pid < 0) {
    throw new Error("target pause state is invalid")
  }
  if (state.containerId !== target.targetContainerId || state.pid !== target.targetPid) throw new Error("target pause identity changed")
  return state
}

function restorePausedTarget(target, run) {
  let lastError
  for (let attempt = 0; attempt < TARGET_THAW_MAX_ATTEMPTS; attempt += 1) {
    try { run(["unpause", target.targetContainerId]) } catch (error) { lastError = error }
    try {
      const resumed = pausedTargetState(target, run)
      if (resumed.running && !resumed.paused && !resumed.restarting && !resumed.dead) return
      lastError = new Error("target resumed state is invalid")
    } catch (error) {
      lastError = error
    }
  }
  throw new Error("target did not resume after bounded thaw attempts", { cause: lastError })
}

function syncWait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function watchdogReceipt(root, expected, dependencies = {}) {
  const fileExists = dependencies.existsSync ?? existsSync
  const readFile = dependencies.readFileSync ?? readFileSync
  const wait = dependencies.syncWait ?? syncWait
  const file = `${root}/watchdog-terminal.json`
  for (let attempt = 0; attempt < 100 && !fileExists(file); attempt += 1) wait(50)
  const receipt = object(JSON.parse(readFile(file, "utf8")), "thaw watchdog terminal receipt")
  if (receipt.status !== expected.status || receipt.containerId !== expected.containerId || receipt.pid !== expected.pid
    || receipt.parentBootId !== expected.parentBootId || receipt.parentStarttime !== expected.parentStarttime) throw new Error("thaw watchdog terminal receipt is invalid")
  return receipt
}

function parseProcStatIdentity(content, expectedPid) {
  const match = /^([0-9]+) \((.*)\) ([A-Za-z]) (.+)\n?$/u.exec(content)
  const fields = match?.[4]?.trim().split(/\s+/u) ?? []
  const starttime = fields[18]
  if (!match || Number(match[1]) !== expectedPid || !starttime || !/^[0-9]+$/u.test(starttime) || starttime === "0") throw new Error("parent process identity is invalid")
  return { state: match[3], starttime }
}

function readParentIdentity(pid) {
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(bootId)) throw new Error("parent boot identity is invalid")
  return { bootId, ...parseProcStatIdentity(readFileSync(`/proc/${pid}/stat`, "utf8"), pid) }
}

function armThawWatchdog(target, dependencies = {}) {
  const now = dependencies.now ?? Date.now
  const readIdentity = dependencies.readParentIdentity ?? readParentIdentity
  const makeDirectory = dependencies.mkdirSync ?? mkdirSync
  const spawnChild = dependencies.spawn ?? spawn
  const fileExists = dependencies.existsSync ?? existsSync
  const wait = dependencies.syncWait ?? syncWait
  const writeFile = dependencies.writeFileSync ?? writeFileSync
  const parentIdentity = readIdentity(process.pid)
  if (parentIdentity.state === "Z") throw new Error("thaw watchdog parent is not alive")
  const root = `/run/ouro-thaw-watchdog.${process.pid}.${now()}`
  makeDirectory(root, { mode: 0o700 })
  const child = spawnChild(process.execPath, [fileURLToPath(import.meta.url), "--thaw-watchdog", target.targetContainerId, String(target.targetPid), String(process.pid), parentIdentity.bootId, parentIdentity.starttime, root], {
    cwd: "/", detached: true, stdio: "ignore",
  })
  child.unref()
  for (let attempt = 0; attempt < 100 && !fileExists(`${root}/ready`); attempt += 1) wait(50)
  if (!fileExists(`${root}/ready`)) throw new Error("thaw watchdog did not arm")
  return {
    disarm() {
      writeFile(`${root}/disarm`, "\n", { flag: "wx", mode: 0o600 })
      return watchdogReceipt(root, { status: "disarmed", containerId: target.targetContainerId, pid: target.targetPid, parentBootId: parentIdentity.bootId, parentStarttime: parentIdentity.starttime }, dependencies)
    },
  }
}

async function runThawWatchdog(targetContainerId, targetPid, parentPid, parentBootId, parentStarttime, root, dependencies = {}) {
  const target = { targetContainerId, targetPid }
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const fileExists = dependencies.existsSync ?? existsSync
  const writeFile = dependencies.writeFileSync ?? writeFileSync
  const readIdentity = dependencies.readParentIdentity ?? readParentIdentity
  const run = dependencies.runDocker ?? runDocker
  const enforcementMs = dependencies.enforcementMs ?? WATCHDOG_PARENT_DEATH_ENFORCEMENT_MS
  const recoveryPollMs = dependencies.recoveryPollMs ?? 250
  const rootIdentity = /^\/run\/ouro-thaw-watchdog\.([0-9]+)\.([0-9]+)$/u.exec(root)
  if (!CONTAINER_ID.test(targetContainerId) || !Number.isSafeInteger(targetPid) || targetPid <= 0
    || !Number.isSafeInteger(parentPid) || parentPid <= 0
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(parentBootId)
    || !/^[0-9]+$/u.test(parentStarttime) || parentStarttime === "0"
    || !rootIdentity || Number(rootIdentity[1]) !== parentPid
    || !Number.isSafeInteger(enforcementMs) || enforcementMs <= 0 || !Number.isSafeInteger(recoveryPollMs) || recoveryPollMs <= 0) throw new Error("thaw watchdog lease is invalid")
  const initial = pausedTargetState(target, run)
  if (!initial.running || initial.paused || initial.restarting || initial.dead) throw new Error("thaw watchdog initial state is invalid")
  writeFile(`${root}/ready`, "\n", { flag: "wx", mode: 0o600 })
  const terminalReceipt = (status) => writeFile(`${root}/watchdog-terminal.json`, `${JSON.stringify({ status, containerId: targetContainerId, pid: targetPid, parentBootId, parentStarttime })}\n`, { flag: "wx", mode: 0o600 })
  for (;;) {
    if (fileExists(`${root}/disarm`)) {
      const restored = pausedTargetState(target, run)
      if (!restored.running || restored.paused || restored.restarting || restored.dead) throw new Error("thaw watchdog disarm state is invalid")
      terminalReceipt("disarmed")
      return
    }
    let parentAlive = false
    try {
      const observed = readIdentity(parentPid)
      parentAlive = observed.bootId === parentBootId && observed.starttime === parentStarttime && observed.state !== "Z"
    } catch {}
    if (!parentAlive) break
    await sleep(WATCHDOG_POLL_MS)
  }
  const deadline = now() + enforcementMs
  const remaining = () => {
    const milliseconds = deadline - now()
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw new Error("thaw watchdog recovery deadline expired")
    return Math.min(20_000, milliseconds)
  }
  for (;;) {
    const state = pausedTargetState(target, run, remaining())
    if (!state.running || state.restarting || state.dead) throw new Error("thaw watchdog target state drifted")
    if (state.paused) run(["unpause", targetContainerId], remaining())
    else if (deadline - now() <= recoveryPollMs) {
      terminalReceipt("parent-death-recovered")
      return
    }
    const sleepMs = Math.min(recoveryPollMs, deadline - now())
    if (sleepMs <= 0) throw new Error("thaw watchdog recovery deadline expired")
    await sleep(sleepMs)
  }
}

function withPausedTarget(target, operation, dependencies = {}) {
  const run = dependencies.runDocker ?? runDocker
  const armWatchdog = dependencies.armWatchdog ?? (dependencies.runDocker ? () => ({ disarm: () => ({ status: "test-disarmed" }) }) : armThawWatchdog)
  const original = pausedTargetState(target, run)
  if (!original.running || original.paused || original.restarting || original.dead) throw new Error("target original running state is invalid")
  const watchdog = armWatchdog(target)
  let result
  let operationError
  let restoreError
  try {
    run(["pause", target.targetContainerId])
    const paused = pausedTargetState(target, run)
    if (!paused.running || !paused.paused || paused.restarting || paused.dead) throw new Error("target paused state is invalid")
    result = operation()
  } catch (error) {
    operationError = error
  } finally {
    try {
      restorePausedTarget(target, run)
    } catch (error) {
      restoreError = error
    }
  }
  if (!restoreError) {
    try { watchdog.disarm() } catch (error) { restoreError = error }
  }
  if (restoreError && operationError) throw new AggregateError([operationError, restoreError], "target scan and restoration both failed")
  if (restoreError) throw new Error("target failed to restore its original running state", { cause: restoreError })
  if (operationError) throw operationError
  return result
}

function dockerTopology() {
  const rows = runDocker(["container", "ls", "-a", "--no-trunc", "--format", "{{json .}}"])
  return rows.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
    .filter((row) => typeof row.Names === "string" && CANONICAL_NAMES.includes(row.Names))
    .map((row) => {
      if (!CONTAINER_ID.test(row.ID)) throw new Error("canonical Butler list identity is invalid")
      return { id: row.ID, name: row.Names }
    })
}

function autostartNames() {
  const content = readFileSync("/var/lib/docker/unraid-autostart", "utf8")
  const names = content.split(/\r?\n/u).map((line) => line.trim().split(/\s+/u)[0]).filter((name) => CANONICAL_NAMES.includes(name))
  if (new Set(names).size !== names.length) throw new Error("canonical autostart inventory is ambiguous")
  return new Set(names)
}

async function captureCanonicalRecords(dependencies = {}) {
  const listed = (dependencies.dockerTopology ?? dockerTopology)()
  if (new Set(listed.map(({ name }) => name)).size !== listed.length || new Set(listed.map(({ id }) => id)).size !== listed.length) throw new Error("canonical Butler topology is ambiguous")
  if (listed.length === 0) throw new Error("canonical Butler topology is empty")
  const inspections = dependencies.inspectCanonical
    ? dependencies.inspectCanonical(listed.map(({ id }) => id))
    : JSON.parse(runDocker(["inspect", ...listed.map(({ id }) => id)]).trim())
  if (!Array.isArray(inspections) || inspections.length !== listed.length) throw new Error("canonical Butler inspection is incomplete")
  const starts = new Set((dependencies.autostartNames ?? (() => [...autostartNames()]))())
  const graphqlRecords = await (dependencies.graphqlAutostartNames ?? queryGraphqlAutostart)()
  if (!(graphqlRecords instanceof Map)) throw new Error("Unraid GraphQL autostart state is invalid")
  const records = inspections.map((entry) => {
    const name = String(entry.Name).replace(/^\//u, "")
    const listedRecord = listed.find(({ id }) => id === entry.Id)
    if (!listedRecord || listedRecord.name !== name) throw new Error("canonical Butler identity changed during atomic inspection")
    return {
      id: entry.Id,
      names: [entry.Name],
      imageId: entry.Image,
      running: entry.State?.Running,
      autoStart: starts.has(name),
      restartPolicy: entry.HostConfig?.RestartPolicy?.Name,
      pid: entry.State?.Pid,
      networkMode: entry.HostConfig?.NetworkMode,
    }
  })
  const recordNames = new Set(records.map(({ names }) => names[0].replace(/^\//u, "")))
  if (!exactSet(recordNames, new Set(graphqlRecords.keys()))) throw new Error("Unraid GraphQL canonical topology presence disagrees with Docker")
  const graphqlStarts = new Set([...graphqlRecords].filter(([, identity]) => identity?.autoStart === true).map(([name]) => name))
  if (!exactSet(starts, graphqlStarts)) throw new Error("Unraid GraphQL and durable autostart state disagree")
  for (const [name, identity] of graphqlRecords) {
    const record = records.find((candidate) => candidate.names[0].replace(/^\//u, "") === name)
    if (!record || record.id !== identity?.containerId || record.autoStart !== identity?.autoStart) throw new Error("Unraid GraphQL autostart identity disagrees with Docker")
  }
  return records
}

function parseProcNet(content, ipv6) {
  return content.split(/\r?\n/u).slice(1).filter(Boolean).map((line) => line.trim().split(/\s+/u)).filter((fields) => fields[3] === "0A").map((fields) => {
    const [address, portHex] = fields[1].split(":")
    const localAddress = ipv6 ? address : [6, 4, 2, 0].map((offset) => Number.parseInt(address.slice(offset, offset + 2), 16)).join(".")
    return { inode: fields[9], localAddress, port: Number.parseInt(portHex, 16) }
  })
}

function parseProcUdp(content, ipv6) {
  return content.split(/\r?\n/u).slice(1).filter(Boolean).map((line) => line.trim().split(/\s+/u)).map((fields) => {
    const [address, portHex] = fields[1].split(":")
    const localAddress = ipv6 ? address : [6, 4, 2, 0].map((offset) => Number.parseInt(address.slice(offset, offset + 2), 16)).join(".")
    return { inode: fields[9], localAddress, port: Number.parseInt(portHex, 16) }
  }).filter(({ port }) => port !== 0)
}

function cgroupProcessIds(rootPid, containerId, dependencies = {}) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || !CONTAINER_ID.test(containerId)) throw new Error("target cgroup identity is invalid")
  const readCgroup = dependencies.readCgroup ?? ((pid) => readFileSync(`/proc/${pid}/cgroup`, "utf8"))
  const readCgroupMembership = dependencies.readCgroupMembership ?? ((file) => readFileSync(file, "utf8"))
  const lines = readCgroup(rootPid).split(/\r?\n/u).filter(Boolean)
  const expectedPath = `/docker/${containerId}`
  if (lines.length !== 1 || lines[0] !== `0::${expectedPath}`) throw new Error("target cgroup is not the exact Docker cgroup-v2 identity")
  const membership = (file, label) => {
    const raw = readCgroupMembership(`/sys/fs/cgroup${expectedPath}/${file}`).trim()
    const ids = raw ? raw.split(/\s+/u).map(Number) : []
    if (ids.length === 0 || ids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0) || new Set(ids).size !== ids.length) throw new Error(`target cgroup ${label} membership is invalid`)
    return ids.sort((left, right) => left - right)
  }
  const processIds = membership("cgroup.procs", "process")
  const threadIds = membership("cgroup.threads", "thread")
  if (!processIds.includes(rootPid)) throw new Error("target root PID is absent from its cgroup")
  if (!processIds.every((pid) => threadIds.includes(pid))) throw new Error("target cgroup thread membership is incomplete")
  return { path: expectedPath, processIds, threadIds }
}

function ownedSocketInodes(threadIds, dependencies = {}) {
  const listFileDescriptors = dependencies.listFileDescriptors ?? ((tid) => readdirSync(`/proc/${tid}/fd`))
  const readDescriptorLink = dependencies.readDescriptorLink ?? ((tid, fd) => readlinkSync(`/proc/${tid}/fd/${fd}`))
  const inodes = []
  for (const tid of threadIds) for (const fd of listFileDescriptors(tid)) {
    const match = /^socket:\[([0-9]+)\]$/u.exec(readDescriptorLink(tid, fd))
    if (match) inodes.push(match[1])
  }
  return inodes
}


function parseProcUnix(content) {
  return content.split(/\r?\n/u).slice(1).filter(Boolean).map((line) => line.trim().split(/\s+/u))
    .filter((fields) => /^[0-9]+$/u.test(fields[6] ?? ""))
    .map((fields) => ({ inode: fields[6], path: fields.slice(7).join(" "), flags: fields[3], type: fields[4], state: fields[5] }))
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right)))
}

function sortedRecords(values) {
  return [...values].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function sameMembership(left, right) {
  return left.path === right.path
    && exactSet(new Set(left.processIds), new Set(right.processIds))
    && exactSet(new Set(left.threadIds), new Set(right.threadIds))
}

function completeContainmentSnapshot(provisional, readers) {
  const netnsBefore = readers.readNetns(provisional.targetPid)
  const membershipBefore = readers.readMembership(provisional.targetPid, provisional.targetContainerId)
  const socketInodesBefore = sortedUnique(readers.readSockets(membershipBefore.threadIds))
  const tcpListenersRaw = readers.readTcp(provisional.targetPid)
  const udpListenersRaw = readers.readUdp(provisional.targetPid)
  const unixSocketsRaw = readers.readUnix(provisional.targetPid)
  const membershipAfter = readers.readMembership(provisional.targetPid, provisional.targetContainerId)
  const socketInodesAfter = sortedUnique(readers.readSockets(membershipAfter.threadIds))
  const netnsAfter = readers.readNetns(provisional.targetPid)
  if (netnsBefore !== netnsAfter || !sameMembership(membershipBefore, membershipAfter)
    || !exactSet(new Set(socketInodesBefore), new Set(socketInodesAfter))) return null
  const owned = new Set(socketInodesAfter)
  return {
    netns: netnsAfter,
    membership: membershipAfter,
    socketInodes: socketInodesAfter,
    tcpListeners: sortedRecords(tcpListenersRaw.filter((listener) => owned.has(listener.inode))),
    udpListeners: sortedRecords(udpListenersRaw.filter((listener) => owned.has(listener.inode))),
    unixSockets: sortedRecords(unixSocketsRaw.filter((socket) => owned.has(socket.inode))),
  }
}

function convergedTerminalContainment(provisional, readers) {
  let previous = null
  for (let attempt = 0; attempt < TERMINAL_CONTAINMENT_MAX_SAMPLES; attempt += 1) {
    const current = completeContainmentSnapshot(provisional, readers)
    if (current && previous && JSON.stringify(current) === JSON.stringify(previous)) return current
    previous = current
  }
  throw new Error("terminal containment snapshot did not converge")
}

async function runDeploymentTargetAudit(profileName, expectedImageId, dependencies = {}) {
  const capture = dependencies.captureCanonicalRecords ?? captureCanonicalRecords
  const before = await capture()
  const provisional = attestDeploymentTarget({ profile: profileName, expectedImageId, topologyBefore: before, inspected: before, topologyAfter: before })
  const readNetns = dependencies.readNetns ?? ((pid) => readlinkSync(`/proc/${pid}/ns/net`))
  const readMembership = dependencies.cgroupProcessIds ?? cgroupProcessIds
  const readSockets = dependencies.ownedSocketInodes ?? ownedSocketInodes
  const readTcp = dependencies.readTcpListeners ?? ((pid) => [...parseProcNet(readFileSync(`/proc/${pid}/net/tcp`, "utf8"), false), ...parseProcNet(readFileSync(`/proc/${pid}/net/tcp6`, "utf8"), true)])
  const readUdp = dependencies.readUdpListeners ?? ((pid) => [...parseProcUdp(readFileSync(`/proc/${pid}/net/udp`, "utf8"), false), ...parseProcUdp(readFileSync(`/proc/${pid}/net/udp6`, "utf8"), true)])
  const readUnix = dependencies.readUnixSockets ?? ((pid) => parseProcUnix(readFileSync(`/proc/${pid}/net/unix`, "utf8")))
  const quiesceTarget = dependencies.quiesceTarget ?? withPausedTarget
  const containment = quiesceTarget(provisional, () => {
    const netnsBefore = readNetns(provisional.targetPid)
    const membershipBefore = readMembership(provisional.targetPid, provisional.targetContainerId)
    const processIdsBefore = membershipBefore.processIds
    const socketInodesBefore = readSockets(membershipBefore.threadIds)
    const tcpListenersBefore = readTcp(provisional.targetPid)
    const udpListenersBefore = readUdp(provisional.targetPid)
    const unixSocketsBefore = readUnix(provisional.targetPid)
    const membershipAfter = readMembership(provisional.targetPid, provisional.targetContainerId)
    if (membershipBefore.path !== membershipAfter.path) throw new Error("target cgroup changed")
    if (JSON.stringify(processIdsBefore) !== JSON.stringify(membershipAfter.processIds)) throw new Error("target cgroup process membership changed")
    if (JSON.stringify(membershipBefore.threadIds) !== JSON.stringify(membershipAfter.threadIds)) throw new Error("target cgroup thread membership changed")
    const processIdsAfter = membershipAfter.processIds
    const socketInodesAfter = readSockets(membershipAfter.threadIds)
    const tcpListenersAfter = readTcp(provisional.targetPid)
    const udpListenersAfter = readUdp(provisional.targetPid)
    const unixSocketsAfter = readUnix(provisional.targetPid)
    const netnsAfter = readNetns(provisional.targetPid)
    const terminal = convergedTerminalContainment(provisional, { readNetns, readMembership, readSockets, readTcp, readUdp, readUnix })
    return { membershipBefore, processIdsBefore, socketInodesBefore, tcpListenersBefore, udpListenersBefore, unixSocketsBefore, membershipAfter, processIdsAfter, socketInodesAfter, tcpListenersAfter, udpListenersAfter, unixSocketsAfter, netnsBefore, netnsAfter, terminal }
  })
  const after = await capture()
  const { membershipBefore, processIdsBefore, socketInodesBefore, tcpListenersBefore, udpListenersBefore, unixSocketsBefore, membershipAfter, processIdsAfter, socketInodesAfter, tcpListenersAfter, udpListenersAfter, unixSocketsAfter, netnsBefore, netnsAfter, terminal } = containment
  const membershipTerminal = terminal.membership
  const socketInodesTerminal = terminal.socketInodes
  const tcpListenersTerminal = terminal.tcpListeners
  const udpListenersTerminal = terminal.udpListeners
  const unixSocketsTerminal = terminal.unixSockets
  const sameIds = (left, right) => exactSet(new Set(left), new Set(right))
  if (netnsBefore !== netnsAfter || netnsAfter !== terminal.netns) throw new Error("target network namespace changed")
  if (membershipBefore.path !== membershipTerminal.path || membershipAfter.path !== membershipTerminal.path) throw new Error("target cgroup changed")
  if (!sameIds(processIdsBefore, membershipTerminal.processIds) || !sameIds(processIdsAfter, membershipTerminal.processIds)) throw new Error("target cgroup process membership changed")
  if (!sameIds(membershipBefore.threadIds, membershipTerminal.threadIds) || !sameIds(membershipAfter.threadIds, membershipTerminal.threadIds)) throw new Error("target cgroup thread membership changed")
  if (!exactSet(new Set(socketInodesBefore), new Set(socketInodesTerminal)) || !exactSet(new Set(socketInodesAfter), new Set(socketInodesTerminal))) throw new Error("target socket ownership changed")
  const deployment = attestDeploymentTarget({ profile: profileName, expectedImageId, topologyBefore: before, inspected: before, topologyAfter: after })
  const listeners = { ...attestOwnedListeners({ rootPid: deployment.targetPid, netnsBefore, netnsAfter, processIdsBefore, processIdsAfter, socketInodesBefore, socketInodesAfter, socketInodesTerminal, tcpListenersBefore, tcpListenersAfter, tcpListenersTerminal, udpListenersBefore, udpListenersAfter, udpListenersTerminal, unixSocketsBefore, unixSocketsAfter, unixSocketsTerminal }), cgroupPath: membershipTerminal.path, threadCount: membershipTerminal.threadIds.length }
  return { schemaVersion: "sanctuary-effective-deployment-v1", deployment, listeners }
}

if (process.argv[1]?.endsWith("sanctuary-deployment-target.mjs") && process.argv[2] === "--thaw-watchdog") {
  const [targetContainerId, rawTargetPid, rawParentPid, parentBootId, parentStarttime, root] = process.argv.slice(3)
  try { await runThawWatchdog(targetContainerId, Number(rawTargetPid), Number(rawParentPid), parentBootId, parentStarttime, root) } catch (error) {
    if (/^\/run\/ouro-thaw-watchdog\.[0-9]+\.[0-9]+$/u.test(root ?? "") && !existsSync(`${root}/watchdog-terminal.json`)) {
      try { writeFileSync(`${root}/watchdog-terminal.json`, `${JSON.stringify({ status: "failed", containerId: targetContainerId, pid: Number(rawTargetPid), parentBootId, parentStarttime, error: error instanceof Error ? error.message.slice(0, 240) : "unknown" })}\n`, { flag: "wx", mode: 0o600 }) } catch {}
    }
    process.exitCode = 1
  }
} else if (process.argv[1]?.endsWith("sanctuary-deployment-target.mjs")) {
  const [profile, expectedImageId] = process.argv.slice(2)
  if (process.argv.length !== 4) process.exitCode = 2
  else {
    try { process.stdout.write(`${JSON.stringify(await runDeploymentTargetAudit(profile, expectedImageId))}\n`) }
    catch { process.exitCode = 1 }
  }
}

export { attestDeploymentTarget, attestOwnedListeners, armThawWatchdog, captureCanonicalRecords, cgroupProcessIds, dockerTopology, ownedSocketInodes, parseProcNet, parseProcStatIdentity, parseProcUdp, parseProcUnix, queryGraphqlAutostart, runDeploymentTargetAudit, runThawWatchdog, targetProfile, withPausedTarget }
