import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createGuardedFs, sameName } from "../../../eval/watch/guarded-fs"

describe("Watch's guarded file access", () => {
  let tmp: string
  let bundles: string
  let bundleFile: string
  let privateDir: string

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "watch-fs-")))
    bundles = path.join(tmp, "AgentBundles")
    fs.mkdirSync(path.join(bundles, "agent.ouro", "state"), { recursive: true })
    bundleFile = path.join(bundles, "agent.ouro", "state", "log.ndjson")
    fs.writeFileSync(bundleFile, "line one\nline two\n")
    privateDir = path.join(tmp, "eval", "watch", "agent")
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const make = () => createGuardedFs({ protectedRoots: [bundles], privateDir })

  it("reads a protected file through one read-only descriptor", () => {
    const gfs = make()
    expect(gfs.readWhole(bundleFile)?.toString()).toBe("line one\nline two\n")
    expect(gfs.withFile(bundleFile, (handle) => [handle.size, handle.read(9).toString(), handle.read(0, 4).toString(), handle.read(99).length])).toEqual([18, "line two\n", "line", 0])
    expect(gfs.readWhole(path.join(bundles, "missing"))).toBeNull()
    expect(gfs.exists(bundleFile)).toBe(true)
    expect(gfs.list(path.join(bundles, "agent.ouro", "state"))).toEqual(["log.ndjson"])
    expect(gfs.list(path.join(bundles, "missing"))).toEqual([])
    expect(() => gfs.withFile(path.join(bundles, "agent.ouro"), (handle) => handle.read(0))).toThrow()
  })

  it("refuses every write, append, rename or unlink under a protected folder", () => {
    const gfs = make()
    for (const flags of ["a", "wx"]) expect(() => gfs.open(bundleFile, flags)).toThrow(/protected/)
    for (const flags of ["w", "r+", "as", "w+"]) expect(() => gfs.open(bundleFile, flags)).toThrow(/flags/)
    expect(() => gfs.rename(bundleFile, path.join(privateDir, "x"))).toThrow(/protected/)
    expect(() => gfs.rename(path.join(privateDir, "x"), bundleFile)).toThrow(/protected/)
    expect(() => gfs.unlink(bundleFile)).toThrow(/protected/)
    expect(fs.readFileSync(bundleFile, "utf8")).toBe("line one\nline two\n")
  })

  it("opens a protected file for reading only", () => {
    const fd = make().open(bundleFile, "r")
    expect(() => fs.writeSync(fd, "x")).toThrow()
    fs.closeSync(fd)
  })

  it("writes only inside its private folder, with owner-only modes", () => {
    const gfs = make()
    gfs.writePrivate("cursor.json", "{}")
    gfs.appendPrivate("rows.ndjson", "a\n")
    gfs.appendPrivate("rows.ndjson", "b\n")
    expect(gfs.readPrivate("rows.ndjson")).toBe("a\nb\n")
    expect(gfs.readPrivate("absent")).toBeNull()
    expect(fs.statSync(privateDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(privateDir, "cursor.json")).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.join(privateDir, "rows.ndjson")).mode & 0o777).toBe(0o600)
    expect(() => gfs.writePrivate("../escape", "x")).toThrow(/private/)
    expect(() => gfs.open(path.join(tmp, "elsewhere"), "a")).toThrow(/private/)
  })

  it("refuses a private file that is a link into a protected folder", () => {
    const gfs = make()
    fs.symlinkSync(bundleFile, path.join(privateDir, "rows.ndjson"))
    expect(() => gfs.appendPrivate("rows.ndjson", "x\n")).toThrow(/protected/)
    expect(fs.readFileSync(bundleFile, "utf8")).toBe("line one\nline two\n")
  })

  it("refuses a dangling link planted in the private folder instead of following it", () => {
    const gfs = make()
    const target = path.join(bundles, "agent.ouro", "planted")
    fs.symlinkSync(target, path.join(privateDir, "rows.ndjson"))
    expect(() => gfs.appendPrivate("rows.ndjson", "x\n")).toThrow(/link/)
    expect(() => gfs.readPrivate("rows.ndjson")).toThrow(/link/)
    fs.symlinkSync(target, path.join(privateDir, "cursor.json.tmp"))
    gfs.writePrivate("cursor.json", "{}")
    expect(fs.existsSync(target)).toBe(false)
    expect(gfs.readPrivate("cursor.json")).toBe("{}")
    expect(fs.readdirSync(path.join(bundles, "agent.ouro"))).toEqual(["state"])
  })

  it("never empties a hard-linked protected file, since no flag truncates", () => {
    const gfs = make()
    const link = path.join(privateDir, "rows.ndjson")
    fs.linkSync(bundleFile, link)
    expect(() => gfs.open(link, "w")).toThrow(/flags/)
    expect(() => gfs.open(link, "a")).toThrow(/link/)
    expect(fs.readFileSync(bundleFile, "utf8")).toBe("line one\nline two\n")
  })

  it("removes a leftover temporary link by its own name, leaving its target alone", () => {
    const gfs = make()
    fs.symlinkSync(bundleFile, path.join(privateDir, "cursor.json.tmp"))
    gfs.writePrivate("cursor.json", "{}")
    expect(gfs.readPrivate("cursor.json")).toBe("{}")
    expect(fs.readFileSync(bundleFile, "utf8")).toBe("line one\nline two\n")
  })

  it("refuses an existing folder holding anything but Watch's own files", () => {
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o755 })
    fs.writeFileSync(path.join(privateDir, "notes.txt"), "mine")
    expect(() => make()).toThrow(/not-empty/)
    expect(fs.statSync(privateDir).mode & 0o777).toBe(0o755)
  })

  it("refuses a hard-linked private file and a write into a folder below the private one", () => {
    const gfs = make()
    gfs.writePrivate("cursor.json", "{}")
    fs.linkSync(path.join(privateDir, "cursor.json"), path.join(tmp, "second-name"))
    expect(() => gfs.appendPrivate("cursor.json", "x")).toThrow(/link/)
    fs.mkdirSync(path.join(privateDir, "sub"))
    expect(() => gfs.open(path.join(privateDir, "sub", "f"), "a")).toThrow(/outside/)
    expect(() => gfs.open(path.join(privateDir, "nope", "f"), "a")).toThrow(/outside/)
    expect(() => gfs.writePrivate("Bad Name", "x")).toThrow(/name/)
  })

  it.runIf(process.platform === "darwin")("sees a protected folder through a different letter case", () => {
    const variant = path.join(tmp, "agentbundles", "agent.ouro", "state", "log.ndjson")
    expect(() => make().open(variant, "a")).toThrow(/protected/)
    expect(() => createGuardedFs({ protectedRoots: [bundles], privateDir: path.join(tmp, "AGENTBUNDLES", "watch") })).toThrow(/protected/)
  })

  it("compares folder names the way each platform does", () => {
    expect(sameName("AgentBundles", "agentbundles", "darwin")).toBe(true)
    expect(sameName("AgentBundles", "agentbundles", "win32")).toBe(true)
    expect(sameName("AgentBundles", "agentbundles", "linux")).toBe(false)
    expect(sameName("AgentBundles", "AgentBundles", "linux")).toBe(true)
  })

  it("passes on other errors, and refuses a private name that is a folder", () => {
    const gfs = make()
    expect(() => gfs.readWhole(path.join(bundleFile, "below-a-file"))).toThrow(/ENOTDIR/)
    fs.mkdirSync(path.join(privateDir, "sub"))
    expect(() => gfs.open(path.join(privateDir, "sub"), "a")).toThrow(/EISDIR/)
    expect(() => gfs.readPrivate("sub")).toThrow(/link/)
    fs.mkdirSync(path.join(privateDir, "cursor.json.tmp"))
    expect(() => gfs.writePrivate("cursor.json", "{}")).toThrow(/E[A-Z]+/)
  })

  it("sees a protected folder by identity when its name differs", () => {
    const alias = path.join(tmp, "alias")
    fs.symlinkSync(bundles, alias)
    const gfs = createGuardedFs({ protectedRoots: [alias], privateDir })
    expect(() => gfs.open(bundleFile, "a")).toThrow(/protected/)
    expect(createGuardedFs({ protectedRoots: [path.join(tmp, "not-yet")], privateDir }).readPrivate("x")).toBeNull()
  })

  it("refuses a private folder that is a link", () => {
    fs.mkdirSync(path.join(tmp, "real"))
    fs.mkdirSync(path.dirname(privateDir), { recursive: true })
    fs.symlinkSync(path.join(tmp, "real"), privateDir)
    expect(() => make()).toThrow(/link/)
  })

  it("refuses a private folder inside a protected folder", () => {
    expect(() => createGuardedFs({ protectedRoots: [bundles], privateDir: path.join(bundles, "watch") })).toThrow(/protected/)
  })

  it("tightens an existing private folder to owner-only", () => {
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o755 })
    make()
    expect(fs.statSync(privateDir).mode & 0o777).toBe(0o700)
  })
})
