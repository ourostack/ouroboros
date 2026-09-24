import { createHash, generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SANCTUARY_CGROUP_KEEP, sanctuaryCgroupChildren, verifySanctuaryAuthorityInstallation } from "../../../heart/daemon/sanctuary-authority-installation"
vi.mock("node:fs", async (original) => ({ ...await original<typeof fs>() }))

const roots: string[] = []
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "authority-install-")))
  roots.push(root)
  const uid = process.getuid!()
  const gid = process.getgid!()
  const packageRoot = path.join(root, "package")
  fs.mkdirSync(packageRoot, { mode: 0o700 })
  const entry = path.join(packageRoot, "gateway.js")
  fs.writeFileSync(entry, "gateway", { mode: 0o600 })
  const manifestPath = path.join(root, "manifest.json")
  const manifest = JSON.stringify({ schemaVersion: 1, files: { "gateway.js": { digest: hash("gateway"), mode: 0o600 } } })
  fs.writeFileSync(manifestPath, manifest, { mode: 0o600 })
  const stateRoot = path.join(root, "state")
  const stagingRoot = path.join(root, "staging")
  const socketRoot = path.join(root, "socket")
  const cgroupRoot = path.join(root, "cgroup")
  for (const name of [stateRoot, stagingRoot, cgroupRoot]) fs.mkdirSync(name, { mode: 0o700 })
  fs.mkdirSync(socketRoot, { mode: 0o750 })
  for (const [name, value] of Object.entries({ "cgroup.controllers": "cpu memory pids\n", "cgroup.subtree_control": "cpu memory pids\n", "cgroup.type": "domain\n", "cgroup.procs": "" })) {
    fs.writeFileSync(path.join(cgroupRoot, name), value, { mode: 0o600 })
  }
  const privateKeyPath = path.join(stateRoot, "issuer.pem")
  const keys = generateKeyPairSync("ed25519")
  fs.writeFileSync(privateKeyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
  const options = {
    packageRoot, manifestPath, manifestDigest: hash(manifest), stateRoot, stagingRoot, socketRoot, cgroupRoot,
    expectedUid: uid, expectedGid: gid, socketGroupId: gid,
    mountInfo: `1 0 0:1 / / rw - rootfs rootfs rw\n2 1 0:2 / ${cgroupRoot} rw - cgroup2 cgroup rw\n`,
  }
  return { root, entry, options }
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe("root authority installation prerequisites", () => {
  it("reads the real mount-inventory boundary, decodes escaped paths, and refuses a changed manifest digest", () => {
    const f = fixture()
    const read = fs.readFileSync
    const inventory = f.options.mountInfo + "3 1 0:3 / /unrelated\\040mount rw - tmpfs tmpfs rw\n"
    vi.spyOn(fs, "readFileSync").mockImplementation(((file, options) => file === "/proc/self/mountinfo" ? inventory : read(file, options)) as typeof fs.readFileSync)
    expect(verifySanctuaryAuthorityInstallation({ ...f.options, mountInfo: undefined }).controllers).toEqual(["cpu", "memory", "pids"])
    expect(() => verifySanctuaryAuthorityInstallation({ ...f.options, manifestDigest: hash("substituted") })).toThrow(/manifest digest/u)
  })
  it("walks immutable nested package directories and refuses writable descendants", () => {
    const f = fixture()
    const directory = path.join(f.options.packageRoot, "nested")
    fs.mkdirSync(directory, { mode: 0o755 })
    fs.renameSync(f.entry, path.join(directory, "gateway.js"))
    const manifest = JSON.stringify({ schemaVersion: 1, files: { "nested/gateway.js": { digest: hash("gateway"), mode: 0o600 } } })
    fs.writeFileSync(f.options.manifestPath, manifest)
    f.options.manifestDigest = hash(manifest)
    expect(verifySanctuaryAuthorityInstallation(f.options)).toBeDefined()
    fs.chmodSync(directory, 0o777)
    expect(() => verifySanctuaryAuthorityInstallation(f.options)).toThrow(/directory/u)
  })
  it("verifies exact owned package bytes, modes, cgroup controllers and executable staging", () => {
    const f = fixture()
    expect(verifySanctuaryAuthorityInstallation(f.options)).toEqual({ packageDigest: f.options.manifestDigest, controllers: ["cpu", "memory", "pids"] })
    expect(fs.readFileSync(f.entry, "utf8")).toBe("gateway")
  })
  it("refuses package substitutions, surplus files, symlinks, parent swaps and wrong ownership without repairing them", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => fs.writeFileSync(f.entry, "changed"),
      (f: ReturnType<typeof fixture>) => fs.writeFileSync(path.join(f.options.packageRoot, "extra.js"), "extra"),
      (f: ReturnType<typeof fixture>) => fs.chmodSync(f.entry, 0o666),
      (f: ReturnType<typeof fixture>) => { fs.unlinkSync(f.entry); fs.symlinkSync(f.options.manifestPath, f.entry) },
      (f: ReturnType<typeof fixture>) => { f.options.expectedUid += 1 },
      (f: ReturnType<typeof fixture>) => { f.options.expectedGid += 1 },
      (f: ReturnType<typeof fixture>) => fs.chmodSync(f.options.stateRoot, 0o755),
      (f: ReturnType<typeof fixture>) => fs.chmodSync(f.options.socketRoot, 0o777),
      (f: ReturnType<typeof fixture>) => { fs.rmdirSync(f.options.stagingRoot); fs.symlinkSync(f.options.stateRoot, f.options.stagingRoot) },
      (f: ReturnType<typeof fixture>) => { f.options.packageRoot += "/.." },
    ]) {
      const f = fixture()
      mutate(f)
      expect(() => verifySanctuaryAuthorityInstallation(f.options)).toThrow()
    }
  })
  it("refuses unavailable resource controls, noexec staging and non-cgroup mount identity", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => fs.writeFileSync(path.join(f.options.cgroupRoot, "cgroup.controllers"), "cpu memory"),
      (f: ReturnType<typeof fixture>) => fs.writeFileSync(path.join(f.options.cgroupRoot, "cgroup.subtree_control"), "cpu pids"),
      (f: ReturnType<typeof fixture>) => fs.writeFileSync(path.join(f.options.cgroupRoot, "cgroup.type"), "threaded"),
      (f: ReturnType<typeof fixture>) => fs.writeFileSync(path.join(f.options.cgroupRoot, "cgroup.procs"), "123\n"),
      (f: ReturnType<typeof fixture>) => { f.options.mountInfo = f.options.mountInfo.replace("cgroup2", "tmpfs") },
      (f: ReturnType<typeof fixture>) => { f.options.mountInfo += `3 1 0:3 / ${f.options.stagingRoot} rw,noexec - tmpfs tmpfs rw\n` },
      (f: ReturnType<typeof fixture>) => { f.options.mountInfo = "" },
    ]) {
      const f = fixture()
      mutate(f)
      expect(() => verifySanctuaryAuthorityInstallation(f.options)).toThrow()
    }
  })
  it("refuses untrusted manifest schemas and paths even when their digest is pinned", () => {
    for (const value of [
      null, [], {}, { schemaVersion: 2, files: {} }, { schemaVersion: 1, files: {} },
      { schemaVersion: 1, files: { "../gateway.js": { digest: hash("gateway"), mode: 0o600 } } },
      { schemaVersion: 1, files: { "/gateway.js": { digest: hash("gateway"), mode: 0o600 } } },
      { schemaVersion: 1, files: { "gateway.js": { digest: hash("gateway"), mode: 0o666 } } },
      { schemaVersion: 1, files: { "gateway.js": { digest: "bad", mode: 0o600 } } },
      { schemaVersion: 1, files: { "gateway.js": { digest: hash("gateway"), mode: 0o600, extra: true } } },
      { schemaVersion: 1, files: { "gateway.js": null } },
      { schemaVersion: 1, files: { "gateway.js": { digest: hash("gateway"), mode: 0o600 } }, extra: true },
    ]) {
      const f = fixture()
      const bytes = JSON.stringify(value)
      fs.writeFileSync(f.options.manifestPath, bytes)
      f.options.manifestDigest = hash(bytes)
      expect(() => verifySanctuaryAuthorityInstallation(f.options)).toThrow()
    }
  })
})

describe("authority cgroup children", () => {
  it("lists execution cgroups and ignores the keep child and control files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "authority-cgroup-"))
    try {
      fs.mkdirSync(path.join(root, SANCTUARY_CGROUP_KEEP))
      fs.mkdirSync(path.join(root, "permit-a"))
      fs.writeFileSync(path.join(root, "cgroup.procs"), "")
      expect(sanctuaryCgroupChildren(root)).toEqual(["permit-a"])
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})
