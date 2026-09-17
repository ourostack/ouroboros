import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { prepareSanctuaryAuthorityEpoch, readSanctuaryAuthorityEpoch, retireSanctuaryAuthorityEpoch, releaseSanctuaryAuthorityToken } from "../../../heart/daemon/sanctuary-authority-epoch"
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})
const actualFs = await vi.importActual<typeof fs>("node:fs")

const roots: string[] = []
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "authority-epoch-")))
  roots.push(root)
  const tokenPath = path.join(root, "token")
  const previousTokenPath = path.join(root, "previous-token")
  fs.writeFileSync(tokenPath, "123:abcdefghijklmnopqrstuvwxyz", { mode: 0o600 })
  fs.writeFileSync(previousTokenPath, "123:zyxwvutsrqponmlkjihgfedcba", { mode: 0o600 })
  const probe = vi.fn(async (token: string) => token.endsWith("zyxwvutsrqponmlkjihgfedcba") ? { status: 401, botId: null } : { status: 200, botId: "123" })
  const input = { root, epochId: "epoch-123", tokenPath, previousTokenPath, botId: "123", ownerUserId: "42", ownerChatId: "42", predecessorCursor: 80, packageDigest: `sha256:${"a".repeat(64)}` }
  const options = { expectedUid: process.getuid!(), expectedGid: process.getgid!(), probe, now: () => "2026-09-17T00:00:00.000Z" }
  return { root, tokenPath, previousTokenPath, input, options, probe }
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
describe("root-only authority token and issuer epochs", () => {
  it("refuses an unsafe issuer temporary and a substituted completed cleanup intent", async () => {
    const f = fixture()
    const temporary = path.join(f.root, "issuer.pem.tmp")
    fs.writeFileSync(temporary, "unrelated", { mode: 0o644 })
    await expect(prepareSanctuaryAuthorityEpoch(f.input, f.options)).rejects.toThrow(/temporary/u)
    expect(fs.readFileSync(temporary, "utf8")).toBe("unrelated")
    fs.unlinkSync(temporary)
    await prepareSanctuaryAuthorityEpoch(f.input, f.options)
    const intent = path.join(f.root, "issuer-intent.json")
    fs.writeFileSync(intent, "{}", { mode: 0o600 })
    await expect(prepareSanctuaryAuthorityEpoch(f.input, f.options)).rejects.toThrow(/cleanup identity/u)
    expect(fs.readFileSync(intent, "utf8")).toBe("{}")
  })
  it("recovers a partial issuer write without publishing a partial key or leaving secret temporaries", async () => {
    const f = fixture()
    const write = fs.writeFileSync
    let fail = true
    const fault = vi.spyOn(fs, "writeFileSync").mockImplementation(((file, bytes, options) => {
      if (fail && typeof file === "number" && typeof bytes === "string" && bytes.startsWith("-----BEGIN PRIVATE KEY-----")) {
        fail = false
        write(file, bytes.slice(0, 30), options)
        throw new Error("issuer write interrupted")
      }
      return write(file, bytes, options)
    }) as typeof fs.writeFileSync)
    await expect(prepareSanctuaryAuthorityEpoch(f.input, f.options)).rejects.toThrow("issuer write interrupted")
    expect(fs.existsSync(path.join(f.root, "issuer.pem"))).toBe(false)
    expect(fs.existsSync(path.join(f.root, "issuer.pem.tmp"))).toBe(false)
    fault.mockRestore()
    expect((await prepareSanctuaryAuthorityEpoch(f.input, f.options)).state).toBe("prepared")
  })
  it("finishes issuer intent cleanup when publication succeeded before interruption", async () => {
    const f = fixture()
    const unlink = fs.unlinkSync
    const fault = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (String(file) === path.join(f.root, "issuer-intent.json")) throw new Error("intent cleanup interrupted")
      unlink(file)
    })
    await expect(prepareSanctuaryAuthorityEpoch(f.input, f.options)).rejects.toThrow("intent cleanup interrupted")
    const key = fs.readFileSync(path.join(f.root, "issuer.pem"), "utf8")
    fault.mockRestore()
    await prepareSanctuaryAuthorityEpoch(f.input, f.options)
    expect(fs.existsSync(path.join(f.root, "issuer-intent.json"))).toBe(false)
    expect(fs.readFileSync(path.join(f.root, "issuer.pem"), "utf8")).toBe(key)
  })
  it("rejects relative and linked token paths and a non-Ed25519 issuer", async () => {
    const f = fixture()
    await expect(prepareSanctuaryAuthorityEpoch({ ...f.input, tokenPath: "relative" }, f.options)).rejects.toThrow(/path/u)
    const linked = path.join(f.root, "link")
    fs.symlinkSync(f.tokenPath, linked)
    await expect(prepareSanctuaryAuthorityEpoch({ ...f.input, tokenPath: linked }, f.options)).rejects.toThrow(/path/u)
    await prepareSanctuaryAuthorityEpoch(f.input, f.options)
    fs.writeFileSync(path.join(f.root, "issuer.pem"), generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" }))
    expect(() => readSanctuaryAuthorityEpoch(f.root, f.options)).toThrow(/Ed25519/u)
  })
  it("refuses substituted epoch public keys, predecessor tokens and handoff records", async () => {
    const f = fixture()
    const epoch = await prepareSanctuaryAuthorityEpoch(f.input, f.options)
    const record = path.join(f.root, "epoch.json")
    fs.writeFileSync(record, JSON.stringify({ ...epoch, publicKeyPem: "changed" }))
    expect(() => readSanctuaryAuthorityEpoch(f.root, f.options)).toThrow(/key/u)
    fs.writeFileSync(record, JSON.stringify(epoch))
    fs.writeFileSync(f.previousTokenPath, "123:differentPreviousTokenabcdefghijk")
    f.probe.mockImplementation(async (token) => token.includes("differentPrevious") ? { status: 401, botId: null } : { status: 200, botId: "123" })
    await expect(prepareSanctuaryAuthorityEpoch(f.input, f.options)).rejects.toThrow(/predecessor/u)
    retireSanctuaryAuthorityEpoch(f.root, { ...f.options, quiescent: true, cursor: 90 })
    releaseSanctuaryAuthorityToken(f.root, { ...f.options, tokenDigest: epoch.tokenDigest, cursor: 90 })
    fs.writeFileSync(f.tokenPath, "123:wrongRestoredTokenabcdefghijk", { mode: 0o600 })
    expect(() => readSanctuaryAuthorityEpoch(f.root, f.options)).toThrow(/token/u)
    fs.writeFileSync(f.tokenPath, "123:abcdefghijklmnopqrstuvwxyz")
    expect(readSanctuaryAuthorityEpoch(f.root, f.options).state).toBe("retired")
    fs.writeFileSync(path.join(f.root, "handoff.json"), "{}")
    expect(() => readSanctuaryAuthorityEpoch(f.root, f.options)).toThrow(/handoff/u)
  })
  it.each([null, [], { state: "invented" }, { predecessorCursor: -1 }, { terminalCursor: 90 }, { createdAt: "bad" }, { createdAt: "2026-09-17" }, { publicKeyDigest: "bad" }])("refuses malformed immutable epoch state %j", async (changed) => {
    const f = fixture()
    const epoch = await prepareSanctuaryAuthorityEpoch(f.input, f.options)
    fs.writeFileSync(path.join(f.root, "epoch.json"), JSON.stringify(changed === null || Array.isArray(changed) ? changed : { ...epoch, ...changed }))
    expect(() => readSanctuaryAuthorityEpoch(f.root, f.options)).toThrow(/epoch/u)
  })
  it("refuses changed issuer intents or key bytes during publication recovery", async () => {
    for (const changed of ["intent", "key"]) {
      const f = fixture()
      vi.mocked(fs.renameSync).mockImplementation((from, to) => {
        if (String(to) === path.join(f.root, "epoch.json")) throw new Error("interrupted")
        actualFs.renameSync(from, to)
      })
      await expect(prepareSanctuaryAuthorityEpoch(f.input, f.options)).rejects.toThrow("interrupted")
      vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync)
      fs.writeFileSync(path.join(f.root, changed === "intent" ? "issuer-intent.json" : "issuer.pem"), changed === "intent" ? "{}" : "changed-key")
      await expect(prepareSanctuaryAuthorityEpoch(f.input, f.options)).rejects.toThrow(/identity|issuer changed/u)
    }
  })
  it("does not treat a filesystem permission error as an absent epoch", async () => {
    const f = fixture()
    const lstat = fs.lstatSync
    vi.spyOn(fs, "lstatSync").mockImplementation(((file, options) => {
      if (String(file) === path.join(f.root, "epoch.json")) throw Object.assign(new Error("denied"), { code: "EACCES" })
      return lstat(file, options)
    }) as typeof fs.lstatSync)
    await expect(prepareSanctuaryAuthorityEpoch(f.input, f.options)).rejects.toThrow("denied")
  })
  it("recovers interruption after issuer creation without creating another key or adopting an unjournalled orphan", async () => {
    const f = fixture()
    const fault = vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      if (String(target) === path.join(f.root, "epoch.json")) throw new Error("epoch publication interrupted")
      actualFs.renameSync(source, target)
    })
    await expect(prepareSanctuaryAuthorityEpoch(f.input, f.options)).rejects.toThrow(/interrupted/u)
    const issuer = fs.readFileSync(path.join(f.root, "issuer.pem"))
    fault.mockImplementation(actualFs.renameSync)
    const epoch = await prepareSanctuaryAuthorityEpoch(f.input, f.options)
    expect(epoch.state).toBe("prepared")
    expect(fs.readFileSync(path.join(f.root, "issuer.pem"))).toEqual(issuer)
  })
  it("releases only the retired current token after exact handoff and keeps the epoch permanently retired", async () => {
    const f = fixture()
    const epoch = await prepareSanctuaryAuthorityEpoch(f.input, f.options)
    expect(() => releaseSanctuaryAuthorityToken(f.root, { ...f.options, tokenDigest: epoch.tokenDigest, cursor: 90 })).toThrow(/retired/u)
    retireSanctuaryAuthorityEpoch(f.root, { ...f.options, quiescent: true, cursor: 90 })
    expect(() => releaseSanctuaryAuthorityToken(f.root, { ...f.options, tokenDigest: epoch.tokenDigest, cursor: 91 })).toThrow(/handoff/u)
    releaseSanctuaryAuthorityToken(f.root, { ...f.options, tokenDigest: epoch.tokenDigest, cursor: 90 })
    expect(fs.existsSync(f.tokenPath)).toBe(false)
    expect(readSanctuaryAuthorityEpoch(f.root, f.options).state).toBe("retired")
    releaseSanctuaryAuthorityToken(f.root, { ...f.options, tokenDigest: epoch.tokenDigest, cursor: 90 })
    expect(fs.existsSync(path.join(f.root, "issuer.pem"))).toBe(true)
  })
  it("creates one durable fresh issuer only after revoked-old and same-bot-new token proof, then restarts byte-identically", async () => {
    const f = fixture()
    const epoch = await prepareSanctuaryAuthorityEpoch(f.input, f.options)
    expect(epoch).toMatchObject({ state: "prepared", epochId: "epoch-123", botId: "123", predecessorCursor: 80, revokedTokenStatus: 401 })
    expect(epoch.publicKeyPem).toContain("PUBLIC KEY")
    expect(fs.lstatSync(path.join(f.root, "issuer.pem")).mode & 0o777).toBe(0o600)
    const seed = fs.readFileSync(path.join(f.root, "issuer.pem"))
    expect(await prepareSanctuaryAuthorityEpoch(f.input, f.options)).toEqual(epoch)
    expect(fs.readFileSync(path.join(f.root, "issuer.pem"))).toEqual(seed)
    expect(readSanctuaryAuthorityEpoch(f.root, f.options)).toEqual(epoch)
    expect(JSON.stringify(epoch)).not.toContain("abcdefghijklmnopqrstuvwxyz")
    expect(JSON.stringify(epoch)).not.toContain("PRIVATE KEY")
  })
  it("does not mint an issuer for two valid tokens, rejected new token, changed bot, network ambiguity or unchanged token", async () => {
    for (const probe of [
      vi.fn(async () => ({ status: 200, botId: "123" })),
      vi.fn(async () => ({ status: 401, botId: null })),
      vi.fn(async (token: string) => token.includes("zyx") ? { status: 401, botId: null } : { status: 200, botId: "456" }),
      vi.fn(async () => ({ status: 500, botId: null })),
      vi.fn(async () => { throw new Error("offline") }),
    ]) {
      const f = fixture()
      await expect(prepareSanctuaryAuthorityEpoch(f.input, { ...f.options, probe })).rejects.toThrow()
      expect(fs.existsSync(path.join(f.root, "issuer.pem"))).toBe(false)
    }
    const f = fixture()
    fs.copyFileSync(f.tokenPath, f.previousTokenPath)
    await expect(prepareSanctuaryAuthorityEpoch(f.input, f.options)).rejects.toThrow(/fresh/u)
    expect(f.probe).not.toHaveBeenCalled()
  })
  it("refuses config/key/token substitutions and unsafe root metadata on restart", async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.input.ownerUserId = "43" },
      (f: ReturnType<typeof fixture>) => { f.input.epochId = "different-epoch" },
      (f: ReturnType<typeof fixture>) => fs.chmodSync(f.root, 0o755),
      (f: ReturnType<typeof fixture>) => fs.chmodSync(f.tokenPath, 0o644),
      (f: ReturnType<typeof fixture>) => fs.writeFileSync(f.tokenPath, "123:anotherFreshTokenValueabcdefghijkl"),
      (f: ReturnType<typeof fixture>) => fs.writeFileSync(path.join(f.root, "issuer.pem"), "bad"),
    ]) {
      const f = fixture()
      await prepareSanctuaryAuthorityEpoch(f.input, f.options)
      mutate(f)
      await expect(prepareSanctuaryAuthorityEpoch(f.input, f.options)).rejects.toThrow()
    }
  })
  it("retires only after exact empty-cgroup proof and never re-enables a retired token/key epoch", async () => {
    const f = fixture()
    const epoch = await prepareSanctuaryAuthorityEpoch(f.input, f.options)
    expect(() => retireSanctuaryAuthorityEpoch(f.root, { ...f.options, quiescent: false, cursor: 90 })).toThrow(/quiescent/u)
    expect(readSanctuaryAuthorityEpoch(f.root, f.options).state).toBe("prepared")
    const retired = retireSanctuaryAuthorityEpoch(f.root, { ...f.options, quiescent: true, cursor: 90 })
    expect(retired).toMatchObject({ ...epoch, state: "retired", terminalCursor: 90 })
    expect(retireSanctuaryAuthorityEpoch(f.root, { ...f.options, quiescent: true, cursor: 90 })).toEqual(retired)
    await expect(prepareSanctuaryAuthorityEpoch(f.input, f.options)).rejects.toThrow(/retired/u)
    expect(() => retireSanctuaryAuthorityEpoch(f.root, { ...f.options, quiescent: true, cursor: 89 })).toThrow(/cursor/u)
    expect(fs.existsSync(path.join(f.root, "issuer.pem"))).toBe(true)
  })
  it.each(["", "null"])("does not reinterpret damaged existing epoch bytes %j as first installation", async (bytes) => {
    const f = fixture()
    await prepareSanctuaryAuthorityEpoch(f.input, f.options)
    retireSanctuaryAuthorityEpoch(f.root, { ...f.options, quiescent: true, cursor: 90 })
    fs.writeFileSync(path.join(f.root, "epoch.json"), bytes)
    await expect(prepareSanctuaryAuthorityEpoch(f.input, f.options)).rejects.toThrow()
    expect(fs.readFileSync(path.join(f.root, "epoch.json"), "utf8")).toBe(bytes)
  })
  it("refuses an issuer without its epoch record instead of reusing a potentially retired key", async () => {
    const f = fixture()
    await prepareSanctuaryAuthorityEpoch(f.input, f.options)
    fs.unlinkSync(path.join(f.root, "epoch.json"))
    await expect(prepareSanctuaryAuthorityEpoch(f.input, f.options)).rejects.toThrow(/orphaned/u)
    expect(fs.existsSync(path.join(f.root, "epoch.json"))).toBe(false)
  })
})
