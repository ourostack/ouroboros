import { CANONICAL_BUNDLE_MANIFEST } from "../../../mind/bundle-manifest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { projectBundle } from "../../../eval/sandbox/projection"

function write(root: string, file: string, text = file): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), text)
}

/** Every file under a folder, relative to it, sorted. */
function files(root: string): string[] {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort()
}

describe("projectBundle", () => {
  let root: string
  let bundleDir: string
  let seedBundleDir: string
  let out: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-projection-"))
    bundleDir = path.join(root, "bundle")
    seedBundleDir = path.join(root, "seed")
    out = path.join(root, "out")
    for (const file of [
      "agent.json", "psyche/SOUL.md", "psyche/TACIT.md", "skills/book-delivery.md",
      "books/books", "books/lib/booklib/libgen.py", "books/credentials.json", "books/ledger.ndjson",
      "books/removed/187-old.epub", "books/work/1-abc/copy.epub", "books/.git/HEAD",
      "friends/ari.json", "state/sessions/ari.json", "desk/today.md", "house/notes.md", "diary/today.md",
      "arc/private.md", "tool-profiles.json", ".git/config", "secrets.txt",
      // An old agent's fact store, which the record migration would move into the now-writable desk (#1734).
      "psyche/memory/facts.jsonl",
    ]) write(bundleDir, file, `private ${file}`)
    fs.chmodSync(path.join(bundleDir, "books/books"), 0o755)
    for (const file of [
      "psyche/TACIT.md", "psyche/SOUL.md", "arc/README.md", "awaiting/house-care-sweep.md", "habits/sanctuary-health.md",
      "tool-profiles.json", "bundle-meta.json", "provider-readiness.json", "agent.json", "state/policy/steward.json",
    ]) write(seedBundleDir, file, `public ${file}`)
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("copies only the included paths, takes the package-managed files from the seed, and leaves out every private path", () => {
    projectBundle({ bundleDir, seedBundleDir, include: ["agent.json", "psyche", "skills", "books"], out })
    expect(files(out)).toEqual([
      "agent.json",
      "arc/README.md",
      "awaiting/house-care-sweep.md",
      "books/books",
      "books/ledger.ndjson",
      "books/lib/booklib/libgen.py",
      "bundle-meta.json",
      "habits/sanctuary-health.md",
      "provider-readiness.json",
      "psyche/SOUL.md",
      "psyche/TACIT.md",
      "skills/book-delivery.md",
      "tool-profiles.json",
    ])
    expect(fs.readFileSync(path.join(out, "agent.json"), "utf8")).toBe("private agent.json")
    expect(fs.readFileSync(path.join(out, "psyche/SOUL.md"), "utf8")).toBe("private psyche/SOUL.md")
    expect(fs.readFileSync(path.join(out, "psyche/TACIT.md"), "utf8")).toBe("public psyche/TACIT.md")
    expect(fs.readFileSync(path.join(out, "tool-profiles.json"), "utf8")).toBe("public tool-profiles.json")
    expect(fs.readFileSync(path.join(out, "arc/README.md"), "utf8")).toBe("public arc/README.md")
    // Executables stay executable, so the skill's absolute command runs.
    expect(fs.statSync(path.join(out, "books/books")).mode & 0o111).not.toBe(0)
  })

  it("starts friends, state, desk and the books CLI's writable places empty, and lists what differs from the live bundle", () => {
    const { gaps } = projectBundle({ bundleDir, seedBundleDir, include: ["agent.json", "psyche", "skills", "books"], out })
    for (const dir of ["friends", "state", "desk/_record/diary/daily", "desk/_record/notes", "books/work", "books/removed"]) {
      expect(fs.readdirSync(path.join(out, dir))).toEqual([])
    }
    expect(fs.readdirSync(path.join(out, "desk"))).toEqual(["_record"])
    expect(fs.readdirSync(path.join(out, "desk/_record"))).toEqual(["diary", "notes"])
    expect(fs.readFileSync(path.join(out, "books/ledger.ndjson"), "utf8")).toBe("")
    expect(gaps.join("\n")).toMatch(/TACIT\.md/)
    expect(gaps.join("\n")).toMatch(/friends/)
    expect(gaps.join("\n")).toMatch(/state/)
    expect(gaps.join("\n")).toMatch(/desk/)
    expect(gaps).toEqual(expect.arrayContaining([expect.stringMatching(/books\/credentials\.json/)]))
  })

  it("has every desk folder a fresh production agent root has", () => {
    projectBundle({ bundleDir, seedBundleDir, include: ["agent.json", "psyche", "skills", "books"], out })
    for (const entry of CANONICAL_BUNDLE_MANIFEST.filter((item) => item.kind === "dir" && item.path.startsWith("desk"))) {
      expect(fs.statSync(path.join(out, entry.path)).isDirectory()).toBe(true)
    }
  })

  it("reports an included path the bundle does not have, and a package-managed file the seed does not have", () => {
    fs.rmSync(path.join(bundleDir, "skills"), { recursive: true })
    fs.rmSync(path.join(seedBundleDir, "habits"), { recursive: true })
    const { gaps } = projectBundle({ bundleDir, seedBundleDir, include: ["agent.json", "skills", "skills/deeper/note.md"], out })
    expect(gaps).toEqual(expect.arrayContaining(["skills: not in the bundle under test", "skills/deeper/note.md: not in the bundle under test", "habits: not in the seed bundle"]))
    expect(fs.existsSync(path.join(out, "skills"))).toBe(false)
    expect(fs.existsSync(path.join(out, "habits"))).toBe(false)
  })

  it("never follows a symbolic link out of the bundle", () => {
    fs.symlinkSync(path.join(bundleDir, "secrets.txt"), path.join(bundleDir, "skills", "linked.md"))
    fs.symlinkSync(path.join(bundleDir, "friends"), path.join(bundleDir, "psyche", "friends-link"))
    const { gaps } = projectBundle({ bundleDir, seedBundleDir, include: ["psyche", "skills"], out })
    expect(fs.existsSync(path.join(out, "skills/linked.md"))).toBe(false)
    expect(fs.existsSync(path.join(out, "psyche/friends-link"))).toBe(false)
    expect(gaps).toEqual(expect.arrayContaining(["skills/linked.md: a symbolic link, left out", "psyche/friends-link: a symbolic link, left out"]))
  })

  it("never follows a symbolic link above an included path", () => {
    fs.symlinkSync(path.join(root, "seed"), path.join(bundleDir, "outside"))
    const { gaps } = projectBundle({ bundleDir, seedBundleDir, include: ["outside/psyche/SOUL.md"], out })
    expect(fs.existsSync(path.join(out, "outside"))).toBe(false)
    expect(gaps).toContain("outside/psyche/SOUL.md: under a symbolic link (outside), left out")
  })

  it("leaves out a private path in any letter case, inside an included folder", () => {
    write(bundleDir, "Friends/ari.json")
    write(bundleDir, "books/Credentials.json")
    projectBundle({ bundleDir, seedBundleDir, include: ["books"], out })
    expect(fs.existsSync(path.join(out, "books/Credentials.json"))).toBe(false)
  })

  it.each([
    ["Friends"], ["STATE/x"], ["books/Credentials.json"], ["Books/Work"], [".Git"],
    ["friends"], ["state"], ["desk"], ["books/credentials.json"], ["books/work"], ["books/removed"], ["books/ledger.ndjson"],
    ["../outside"], ["/etc"], [".git"], ["psyche/../friends"],
  ])("refuses to include %s", (include) => {
    expect(() => projectBundle({ bundleDir, seedBundleDir, include: [include], out })).toThrow(/cannot include/)
  })

  it("leaves the bundle's MCP servers out of agent.json, so the sandbox starts none, and says which", () => {
    write(bundleDir, "agent.json", JSON.stringify({ name: "sanctuary", mcpServers: { media: { command: "node" }, ouro_workbench: { command: "ouro" } } }))
    const { gaps } = projectBundle({ bundleDir, seedBundleDir, include: ["agent.json"], out })
    expect(JSON.parse(fs.readFileSync(path.join(out, "agent.json"), "utf8"))).toEqual({ name: "sanctuary" })
    expect(gaps).toContain("agent.json: its MCP servers (media, ouro_workbench) are left out; the sandbox starts no MCP server")
  })

  it.each([
    ["no MCP servers", JSON.stringify({ name: "sanctuary", mcpServers: {} })],
    ["MCP servers that are not a map", JSON.stringify({ name: "sanctuary", mcpServers: "none" })],
    ["null", "null"],
  ])("leaves an agent.json with %s as it is", (_what, text) => {
    write(bundleDir, "agent.json", text)
    const { gaps } = projectBundle({ bundleDir, seedBundleDir, include: ["agent.json"], out })
    expect(fs.readFileSync(path.join(out, "agent.json"), "utf8")).toBe(text)
    expect(gaps.join("\n")).not.toMatch(/MCP servers/)
  })

  it("refuses an output folder that already exists", () => {
    fs.mkdirSync(out)
    expect(() => projectBundle({ bundleDir, seedBundleDir, include: ["agent.json"], out })).toThrow(/already exists/)
  })
})
