#!/usr/local/bin/node

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, chownSync, closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"

const KEY_ROOT = "/boot/config/plugins/dynamix.my.servers/keys"
const RECOVERY_ROOT = "/mnt/user/appdata/ouro-butler/acceptance/revoked-key-proof"
const UNRAID_API = "/usr/local/sbin/unraid-api"
const DOCKER = "/usr/bin/docker"
const PRODUCTION_CONTAINER = "ouro-butler"
const GRAPHQL_ENDPOINT = "http://127.0.0.1/graphql"
const BOOT_ID = "/proc/sys/kernel/random/boot_id"
const TARGET_SERVER = "sanctuary-unraid"
const TARGET_HOST = "sanctuary"
const KEY_ID = /^[A-Za-z0-9._:-]+$/u
const KEY_NAME = /^Butler (?:RO|RW)(?: Rotation [0-9a-f]{16})?$/u
const PERMISSION = /^[A-Z_]+:(?:CREATE|READ|UPDATE|DELETE)_(?:ANY|OWN)$/u
const MAX_REQUEST = 256 * 1024
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u
let expectedImageId = ""

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

function containerSnapshot(expectedImage) {
  text(expectedImage, "expected image id", IMAGE_ID)
  const template = '{"containerId":{{json .Id}},"imageId":{{json .Image}},"running":{{json .State.Running}},"health":{{json .State.Health.Status}},"user":{{json .Config.User}},"readOnlyRoot":{{json .HostConfig.ReadonlyRootfs}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}},"networkMode":{{json .HostConfig.NetworkMode}},"restartPolicy":{{json .HostConfig.RestartPolicy.Name}},"restartCount":{{json .RestartCount}}}'
  const result = spawnSync(DOCKER, ["inspect", "--format", template, PRODUCTION_CONTAINER], {
    cwd: "/", encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" },
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.error || result.status !== 0) throw new Error("bounded production container inspection failed")
  const value = object(JSON.parse(result.stdout), "production container inspection")
  if (value.imageId !== expectedImage || !Number.isSafeInteger(value.restartCount) || value.restartCount < 0) {
    throw new Error("production container identity is invalid")
  }
  const ports = object(value.ports ?? {}, "published ports")
  const publishedPortCount = Object.values(ports).reduce((count, bindings) => count + (Array.isArray(bindings) ? bindings.length : 0), 0)
  const mounts = Array.isArray(value.mounts) ? value.mounts.map((raw) => {
    const mount = object(raw, "container mount")
    return { destination: mount.Destination, mode: mount.Mode, propagation: mount.Propagation, rw: mount.RW, type: mount.Type }
  }).sort((left, right) => String(left.destination).localeCompare(String(right.destination))) : []
  return {
    schemaVersion: 1,
    containerId: text(value.containerId, "container id", /^[0-9a-f]{64}$/u),
    imageId: expectedImage,
    running: value.running === true,
    health: text(value.health, "container health", /^(?:healthy|starting|unhealthy|missing)$/u),
    user: text(value.user, "container user"),
    readOnlyRoot: value.readOnlyRoot === true,
    mountCount: mounts.length,
    mountsDigest: createHash("sha256").update(JSON.stringify(mounts)).digest("hex"),
    publishedPortCount,
    networkMode: text(value.networkMode, "container network mode"),
    restartPolicy: text(value.restartPolicy, "container restart policy"),
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

async function dispatch(request, dependencies = {
  readBootId: () => readFileSync(BOOT_ID, "utf8"),
  containerSnapshot: () => containerSnapshot(expectedImageId),
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
    exactKeys(payload, ["operation", "targetId", "idempotencyKey"], operation)
    if (payload.targetId !== TARGET_HOST) throw new Error("target host is invalid")
    const key = text(payload.idempotencyKey, "idempotency key", /^[0-9a-f]{32}$/u)
    const prebootId = text(dependencies.readBootId().trim(), "boot id", /^[A-Za-z0-9-]{4,128}$/u)
    return { accepted: true, targetId: TARGET_HOST, requestId: createHash("sha256").update(`sanctuary-reboot\0${key}`).digest("hex"), prebootId, staged: true }
  }
  if (operation === "container_snapshot") {
    exactKeys(payload, ["operation", "targetId"], operation)
    if (payload.targetId !== TARGET_HOST) throw new Error("target host is invalid")
    return dependencies.containerSnapshot()
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
  const [socket, closedInventory, expectedImage] = process.argv.slice(2)
  if (!socket || !closedInventory || !expectedImage || process.argv.length !== 5) throw new Error("usage: broker <socket> <closed-inventory> <expected-image-id>")
  expectedImageId = text(expectedImage, "expected image id", IMAGE_ID)
  rmSync(socket, { force: true })
  writeClosedInventory(closedInventory)
  const server = createServer((connection) => {
    let input = ""
    connection.setEncoding("utf8")
    connection.on("data", (chunk) => {
      input += chunk
      if (Buffer.byteLength(input) > MAX_REQUEST) connection.destroy()
    })
    connection.on("end", async () => {
      try {
        const result = await dispatch(JSON.parse(input))
        connection.end(`${JSON.stringify({ ok: true, result })}\n`)
      } catch { connection.end(`${JSON.stringify({ ok: false, error: "host operation failed" })}\n`) }
    })
  })
  server.listen(socket, () => {
    chownSync(socket, 0, 10001)
    chmodSync(socket, 0o660)
  })
}

if (process.argv[1]?.endsWith("sanctuary-unit16-host-broker.mjs")) {
  main().catch(() => { process.exitCode = 1 })
}

export { dispatch }
