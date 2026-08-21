#!/usr/local/bin/node

import { spawnSync } from "node:child_process"
import { readFileSync, readlinkSync, readdirSync } from "node:fs"

const DOCKER = "/usr/bin/docker"
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

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function targetProfile(name) {
  const profile = PROFILES[name]
  if (!profile) throw new Error("deployment target profile is invalid")
  return profile
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
  if (!Array.isArray(value.processIds) || value.processIds.length === 0 || !value.processIds.includes(value.rootPid) || value.processIds.some((pid) => !Number.isSafeInteger(pid) || pid <= 0) || new Set(value.processIds).size !== value.processIds.length) throw new Error("target process tree is invalid")
  if (!Array.isArray(value.socketInodes) || value.socketInodes.some((inode) => !/^[0-9]+$/u.test(inode)) || new Set(value.socketInodes).size !== value.socketInodes.length) throw new Error("target socket ownership is ambiguous")
  const owned = new Set(value.socketInodes)
  if (!Array.isArray(value.tcpListeners) || !Array.isArray(value.unixSockets)) throw new Error("listener inventory is invalid")
  const tcp = value.tcpListeners.filter((raw) => owned.has(object(raw, "TCP listener").inode))
  for (const listener of tcp) {
    if (listener.localAddress !== "127.0.0.1" || !DOCUMENTED_LOOPBACK_TCP_CONTROLS.has(listener.port)) throw new Error("target runtime owns an inbound TCP listener")
  }
  const unix = value.unixSockets.filter((raw) => owned.has(object(raw, "Unix socket").inode))
  for (const socket of unix) if (!DOCUMENTED_UNIX_CONTROLS.includes(socket.path)) throw new Error("target runtime owns an undocumented Unix listener")
  return { schemaVersion: "sanctuary-listener-containment-v1", targetRootPid: value.rootPid, networkNamespace: value.netnsBefore, processCount: value.processIds.length, ownedSocketCount: owned.size, inboundTcpListenerCount: 0, loopbackTcpControlCount: tcp.length, unixControlSocketCount: unix.length }
}

function runDocker(args) {
  const result = spawnSync(DOCKER, args, { cwd: "/", encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" }, stdio: ["ignore", "pipe", "ignore"] })
  if (result.error || result.status !== 0) throw new Error("bounded deployment target inspection failed")
  return result.stdout
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

function captureCanonicalRecords(dependencies = {}) {
  const listed = (dependencies.dockerTopology ?? dockerTopology)()
  if (new Set(listed.map(({ name }) => name)).size !== listed.length || new Set(listed.map(({ id }) => id)).size !== listed.length) throw new Error("canonical Butler topology is ambiguous")
  if (listed.length === 0) throw new Error("canonical Butler topology is empty")
  const inspections = dependencies.inspectCanonical
    ? dependencies.inspectCanonical(listed.map(({ id }) => id))
    : JSON.parse(runDocker(["inspect", ...listed.map(({ id }) => id)]).trim())
  if (!Array.isArray(inspections) || inspections.length !== listed.length) throw new Error("canonical Butler inspection is incomplete")
  const starts = new Set((dependencies.autostartNames ?? (() => [...autostartNames()]))())
  return inspections.map((entry) => {
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
}

function parseProcNet(content, ipv6) {
  return content.split(/\r?\n/u).slice(1).filter(Boolean).map((line) => line.trim().split(/\s+/u)).filter((fields) => fields[3] === "0A").map((fields) => {
    const [address, portHex] = fields[1].split(":")
    const localAddress = ipv6 ? address : [6, 4, 2, 0].map((offset) => Number.parseInt(address.slice(offset, offset + 2), 16)).join(".")
    return { inode: fields[9], localAddress, port: Number.parseInt(portHex, 16) }
  })
}

function processTree(rootPid) {
  const pending = [rootPid]
  const result = []
  while (pending.length) {
    const pid = pending.shift()
    if (result.includes(pid)) throw new Error("target process tree is ambiguous")
    result.push(pid)
    const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim()
    if (children) pending.push(...children.split(/\s+/u).map(Number))
  }
  return result
}

function ownedSocketInodes(processIds) {
  const inodes = []
  for (const pid of processIds) for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    const match = /^socket:\[([0-9]+)\]$/u.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))
    if (match) inodes.push(match[1])
  }
  return inodes
}


function parseProcUnix(content) {
  return content.split(/\r?\n/u).slice(1).filter(Boolean).map((line) => line.trim().split(/\s+/u)).filter((fields) => fields[3] === "00010000" && fields[4] === "0001" && fields[5] === "01").map((fields) => ({ inode: fields[6], path: fields[7] ?? "" }))
}

function runDeploymentTargetAudit(profileName, expectedImageId, dependencies = {}) {
  const capture = dependencies.captureCanonicalRecords ?? captureCanonicalRecords
  const before = capture()
  const provisional = attestDeploymentTarget({ profile: profileName, expectedImageId, topologyBefore: before, inspected: before, topologyAfter: before })
  const readNetns = dependencies.readNetns ?? ((pid) => readlinkSync(`/proc/${pid}/ns/net`))
  const readTree = dependencies.processTree ?? processTree
  const readSockets = dependencies.ownedSocketInodes ?? ownedSocketInodes
  const readTcp = dependencies.readTcpListeners ?? ((pid) => [...parseProcNet(readFileSync(`/proc/${pid}/net/tcp`, "utf8"), false), ...parseProcNet(readFileSync(`/proc/${pid}/net/tcp6`, "utf8"), true)])
  const readUnix = dependencies.readUnixSockets ?? ((pid) => parseProcUnix(readFileSync(`/proc/${pid}/net/unix`, "utf8")))
  const netnsBefore = readNetns(provisional.targetPid)
  const processIds = readTree(provisional.targetPid)
  const socketInodes = readSockets(processIds)
  const tcpListeners = readTcp(provisional.targetPid)
  const unixSockets = readUnix(provisional.targetPid)
  const netnsAfter = readNetns(provisional.targetPid)
  const after = capture()
  const deployment = attestDeploymentTarget({ profile: profileName, expectedImageId, topologyBefore: before, inspected: before, topologyAfter: after })
  const listeners = attestOwnedListeners({ rootPid: deployment.targetPid, netnsBefore, netnsAfter, processIds, socketInodes, tcpListeners, unixSockets })
  return { schemaVersion: "sanctuary-effective-deployment-v1", deployment, listeners }
}

if (process.argv[1]?.endsWith("sanctuary-deployment-target.mjs")) {
  const [profile, expectedImageId] = process.argv.slice(2)
  if (process.argv.length !== 4) process.exitCode = 2
  else {
    try { process.stdout.write(`${JSON.stringify(runDeploymentTargetAudit(profile, expectedImageId))}\n`) }
    catch { process.exitCode = 1 }
  }
}

export { attestDeploymentTarget, attestOwnedListeners, captureCanonicalRecords, dockerTopology, ownedSocketInodes, parseProcNet, parseProcUnix, processTree, runDeploymentTargetAudit, targetProfile }
