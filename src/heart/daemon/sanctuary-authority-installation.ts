import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"

interface Installation {
  packageRoot: string
  manifestPath: string
  manifestDigest: string
  stateRoot: string
  stagingRoot: string
  socketRoot: string
  cgroupRoot: string
  expectedUid: number
  expectedGid: number
  socketGroupId: number
  mountInfo?: string
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function canonical(filePath: string): void {
  if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath || fs.realpathSync(filePath) !== filePath) {
    throw new Error("Sanctuary authority installation path is not canonical")
  }
}

function directory(filePath: string, uid: number, gid: number, mode: number): void {
  canonical(filePath)
  const stat = fs.lstatSync(filePath)
  if (!stat.isDirectory() || stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o7777) !== mode) {
    throw new Error("Sanctuary authority installation directory metadata changed")
  }
}

function readOwned(filePath: string, uid: number, gid: number, mode: number): Buffer {
  canonical(filePath)
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o7777) !== mode || stat.nlink !== 1) {
      throw new Error("Sanctuary authority installation file metadata changed")
    }
    return fs.readFileSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

export function verifySanctuaryAuthorityInstallation(input: Installation): { packageDigest: string; controllers: string[] } {
  const { expectedUid: uid, expectedGid: gid } = input
  for (const root of [input.packageRoot, input.stateRoot, input.stagingRoot, input.cgroupRoot]) directory(root, uid, gid, 0o700)
  directory(input.socketRoot, uid, input.socketGroupId, 0o750)
  const bytes = readOwned(input.manifestPath, uid, gid, 0o600)
  if (digest(bytes) !== input.manifestDigest) throw new Error("Sanctuary authority package manifest digest changed")
  const manifest: unknown = JSON.parse(bytes.toString("utf8"))
  if (!object(manifest) || Object.keys(manifest).sort().join(",") !== "files,schemaVersion" || manifest.schemaVersion !== 1 || !object(manifest.files) || Object.keys(manifest.files).length === 0) {
    throw new Error("Sanctuary authority package manifest is invalid")
  }
  const expected = Object.keys(manifest.files).sort()
  for (const relative of expected) {
    const pin = manifest.files[relative]
    if (!/^[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*$/u.test(relative) || relative.split("/").some((part) => part === "." || part === "..")
      || !object(pin) || Object.keys(pin).sort().join(",") !== "digest,mode"
      || typeof pin.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(pin.digest) || ![0o600, 0o644, 0o700, 0o755].includes(pin.mode as number)) {
      throw new Error("Sanctuary authority package file pin is invalid")
    }
    if (digest(readOwned(path.join(input.packageRoot, relative), uid, gid, pin.mode as number)) !== pin.digest) throw new Error("Sanctuary authority package file digest changed")
  }
  const actual: string[] = []
  const walk = (relative: string): void => {
    for (const entry of fs.readdirSync(path.join(input.packageRoot, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name)
      const filePath = path.join(input.packageRoot, name)
      if (entry.isDirectory()) {
        const stat = fs.lstatSync(filePath)
        canonical(filePath)
        if (stat.uid !== uid || stat.gid !== gid || ![0o700, 0o755].includes(stat.mode & 0o7777)) throw new Error("Sanctuary authority package directory is unsafe")
        walk(name)
      } else {
        actual.push(name)
      }
    }
  }
  walk("")
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) throw new Error("Sanctuary authority package inventory changed")
  const controllers = ["cpu", "memory", "pids"]
  const readControl = (name: string) => fs.readFileSync(path.join(input.cgroupRoot, name), "utf8").trim()
  for (const name of ["cgroup.controllers", "cgroup.subtree_control"]) {
    const enabled = readControl(name).split(/\s+/u)
    if (!controllers.every((controller) => enabled.includes(controller))) throw new Error("Sanctuary authority cgroup controllers are unavailable")
  }
  if (readControl("cgroup.type") !== "domain" || readControl("cgroup.procs") !== "") throw new Error("Sanctuary authority cgroup domain is invalid")
  const mounts = (input.mountInfo ?? fs.readFileSync("/proc/self/mountinfo", "utf8")).trim().split("\n").map((line) => {
    const fields = line.split(" ")
    const separator = fields.indexOf("-")
    if (fields.length < 10 || separator < 6) throw new Error("Sanctuary authority mount inventory is invalid")
    return { target: fields[4]!.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8))), options: fields[5]!.split(","), type: fields[separator + 1] }
  })
  const mountFor = (filePath: string) => mounts.filter(({ target }) => target === "/" || filePath === target || filePath.startsWith(`${target}/`)).sort((a, b) => b.target.length - a.target.length)[0]
  const stagingMount = mountFor(input.stagingRoot)
  const cgroupMount = mountFor(input.cgroupRoot)
  if (!stagingMount || stagingMount.options.includes("noexec") || stagingMount.options.includes("ro") || cgroupMount?.type !== "cgroup2" || cgroupMount.options.includes("ro")) {
    throw new Error("Sanctuary authority staging or cgroup mount prerequisites are unavailable")
  }
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_authority_installation_verified", message: "Sanctuary authority installation prerequisites verified", meta: { packageDigest: input.manifestDigest } })
  return { packageDigest: input.manifestDigest, controllers }
}
