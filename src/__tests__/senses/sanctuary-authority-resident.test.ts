import { createHash, generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openSanctuaryResidentAuthority } from "../../senses/sanctuary-authority-resident"
import { signAuthorityPayload } from "../../heart/daemon/sanctuary-authority-codec"
import { createSanctuaryAcceptanceAdapterDependencies } from "../../heart/daemon/sanctuary-acceptance-adapter"
import { createSanctuaryAcceptanceHarnessDependencies } from "../../heart/daemon/sanctuary-acceptance-harness"

vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>() }))

const roots: string[] = []
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resident-authority-")))
  roots.push(root)
  fs.chmodSync(root, 0o750)
  const keys = generateKeyPairSync("ed25519")
  const config = {
    schemaVersion: 1, targetHost: "sanctuary", botId: "123", ownerUserId: "42", ownerChatId: "42", keyId: "epoch-1",
    publicKeyDigest: `sha256:${createHash("sha256").update(keys.publicKey.export({ format: "der", type: "spki" })).digest("hex")}`,
    publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
  }
  const configPath = path.join(root, "resident.json")
  const write = (value: unknown) => fs.writeFileSync(configPath, JSON.stringify(value), { mode: 0o640 })
  write(config)
  const client = { request: vi.fn(async () => ({ id: 123 })), close: vi.fn() }
  const options = { configPath, expectedUid: process.getuid!(), expectedGid: process.getgid!(), createClient: vi.fn(() => client) }
  return { root, config, configPath, write, client, options, keys }
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
describe("resident authority pins", () => {
  it("opens the production defaults from public socket pins without loading a token or vault inventory", () => {
    const f = fixture()
    const originalOpen = fs.openSync
    const originalStat = fs.fstatSync
    const fd = originalOpen(f.configPath, "r")
    const directory = fs.lstatSync(f.root)
    vi.spyOn(fs, "lstatSync").mockImplementation((file) => {
      expect(file).toBe("/run/ouro-authority")
      return Object.assign(directory, { uid: 0, gid: 10001 })
    })
    vi.spyOn(fs, "realpathSync").mockImplementation((file) => String(file))
    vi.spyOn(fs, "openSync").mockImplementation((file, flags) => {
      expect(file).toBe("/run/ouro-authority/resident.json")
      expect(flags).toBe(fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      return originalOpen(f.configPath, flags)
    })
    vi.spyOn(fs, "fstatSync").mockImplementation((descriptor) => Object.assign(originalStat(descriptor), { uid: 0, gid: 10001 }))
    fs.closeSync(fd)
    for (const open of [
      () => openSanctuaryResidentAuthority({}, {}),
      createSanctuaryAcceptanceAdapterDependencies().gateway!,
      createSanctuaryAcceptanceHarnessDependencies().gateway!,
    ]) {
      const connection = open()
      expect(connection.credentials).toEqual({ botId: "123", authorizedUserId: "42", authorizedChatId: "42" })
      connection.authorityTransport.api.stop()
    }
  })
  it("checks cursor freshness at receipt after waiting behind a root long poll", async () => {
    const f = fixture()
    const started = Date.parse("2026-09-17T00:00:00.000Z")
    const clock = vi.spyOn(Date, "now").mockReturnValue(started)
    const payload = { targetHost: "sanctuary", botId: "123", ownerUserId: "42", ownerChatId: "42", keyId: "epoch-1", publicKeyDigest: f.config.publicKeyDigest, cursor: 7, pendingUpdateIds: [], progressDigest: `sha256:${"a".repeat(64)}`, observedAt: new Date(started + 50_000).toISOString() }
    f.client.request.mockImplementation(async () => {
      clock.mockReturnValue(started + 50_000)
      return signAuthorityPayload({ domain: "ouro.sanctuary.telegram-cursor.v1", keyId: "epoch-1", privateKey: f.keys.privateKey, payload }) as never
    })
    const connection = openSanctuaryResidentAuthority({}, {}, f.options)
    await expect(connection.cursorSnapshot()).resolves.toEqual(payload)
    connection.authorityTransport.api.stop()
  })
  it("accepts only a fresh signed logical cursor from its pinned gateway", async () => {
    const f = fixture()
    const connection = openSanctuaryResidentAuthority({}, {}, f.options)
    const now = "2026-09-17T00:00:00.000Z"
    const payload = { targetHost: "sanctuary", botId: "123", ownerUserId: "42", ownerChatId: "42", keyId: "epoch-1", publicKeyDigest: f.config.publicKeyDigest, cursor: 7, pendingUpdateIds: [], progressDigest: `sha256:${"a".repeat(64)}`, observedAt: now }
    const sign = (value: unknown) => signAuthorityPayload({ domain: "ouro.sanctuary.telegram-cursor.v1", keyId: "epoch-1", privateKey: f.keys.privateKey, payload: value })
    f.client.request.mockResolvedValue(sign(payload) as never)
    expect(await connection.cursorSnapshot(Date.parse(now))).toEqual(payload)
    expect(f.client.request).toHaveBeenCalledWith("telegram.cursor.snapshot", {})
    for (const changed of [
      { ...payload, cursor: -1 }, { ...payload, pendingUpdateIds: [6] }, { ...payload, pendingUpdateIds: [7, 7] },
      { ...payload, progressDigest: "bad" }, { ...payload, botId: "999" }, { ...payload, ownerUserId: "99" },
      { ...payload, observedAt: "2026-09-16T23:59:00.000Z" }, { ...payload, observedAt: "2026-09-17T00:01:00.000Z" }, { ...payload, extra: 1 },
    ]) {
      f.client.request.mockResolvedValue(sign(changed) as never)
      await expect(connection.cursorSnapshot(Date.parse(now))).rejects.toThrow()
    }
    f.client.request.mockResolvedValue(payload as never)
    await expect(connection.cursorSnapshot(Date.parse(now))).rejects.toThrow()
    connection.authorityTransport.api.stop()
  })
  it("opens only the root-owned socket transport with a pinned Ed25519 issuer and tokenless identity", async () => {
    const f = fixture()
    const result = openSanctuaryResidentAuthority({}, {}, f.options)
    expect(result.credentials).toEqual({ botId: "123", authorizedUserId: "42", authorizedChatId: "42" })
    expect(f.options.createClient).toHaveBeenCalledWith(path.join(f.root, "authority.sock"))
    await result.authorityTransport.api.request("getMe", {})
    expect(f.client.request).toHaveBeenCalledWith("telegram.request", { method: "getMe", body: {} })
    result.authorityTransport.api.stop()
    expect(f.client.close).toHaveBeenCalledOnce()
  })
  it("refuses resident token residue in either credential owner before opening a socket", () => {
    const f = fixture()
    for (const token of ["old-token", "", null, undefined]) {
      expect(() => openSanctuaryResidentAuthority({ telegramBotToken: token }, {}, f.options)).toThrow(/token/u)
      expect(() => openSanctuaryResidentAuthority({}, { telegramBotToken: token }, f.options)).toThrow(/token/u)
    }
    expect(f.options.createClient).not.toHaveBeenCalled()
  })
  it("refuses absent, stale, wrong-key and malformed pins", () => {
    const f = fixture()
    for (const config of [
      null, [], {}, { ...f.config, schemaVersion: 2 }, { ...f.config, targetHost: "another-host" },
      { ...f.config, botId: "0" }, { ...f.config, ownerUserId: "" }, { ...f.config, ownerChatId: "43" },
      { ...f.config, keyId: "" }, { ...f.config, publicKeyDigest: `sha256:${"0".repeat(64)}` },
      { ...f.config, publicKeyPem: "invalid" }, { ...f.config, token: "secret" },
      { ...f.config, publicKeyPem: generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "pem", type: "spki" }).toString() },
    ]) {
      f.write(config)
      expect(() => openSanctuaryResidentAuthority({}, {}, f.options)).toThrow()
    }
    fs.unlinkSync(f.configPath)
    expect(() => openSanctuaryResidentAuthority({}, {}, f.options)).toThrow()
    expect(f.options.createClient).not.toHaveBeenCalled()
  })
  it("refuses writable, foreign-owned, linked and replaced pin paths", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => fs.chmodSync(f.configPath, 0o660),
      (f: ReturnType<typeof fixture>) => fs.chmodSync(f.root, 0o770),
      (f: ReturnType<typeof fixture>) => { f.options.expectedUid += 1 },
      (f: ReturnType<typeof fixture>) => { f.options.expectedGid += 1 },
      (f: ReturnType<typeof fixture>) => { fs.renameSync(f.configPath, path.join(f.root, "other")); fs.symlinkSync(path.join(f.root, "other"), f.configPath) },
      (f: ReturnType<typeof fixture>) => fs.linkSync(f.configPath, path.join(f.root, "linked")),
    ]) {
      const f = fixture()
      mutate(f)
      expect(() => openSanctuaryResidentAuthority({}, {}, f.options)).toThrow()
      expect(f.options.createClient).not.toHaveBeenCalled()
    }
  })
})
