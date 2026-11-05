// Psyche edits take effect on the very next prompt build, for every agent. Before alpha.978 the psyche was cached per
// agent root for the life of the process, so an edit by the agent, its owner or a sync pull waited for a restart.
// The cache compares content, not stat data, because mtimes are unreliable on FUSE shares.
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { loadPsycheAt, resetPsycheCache } from "../../mind/prompt"

describe("the psyche cache follows the files", () => {
  let root: string
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "psyche-reload-"))
    resetPsycheCache()
    write("psyche/SOUL.md", "soul one")
    write("psyche/TACIT.md", "tacit one")
  })
  afterEach(() => {
    resetPsycheCache()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("serves the cached text while nothing changed", () => {
    const first = loadPsycheAt(root)
    expect(loadPsycheAt(root)).toBe(first)
  })

  it("picks up an edit on the next load", () => {
    expect(loadPsycheAt(root).soul).toBe("soul one")
    write("psyche/SOUL.md", "soul two, longer")
    expect(loadPsycheAt(root).soul).toBe("soul two, longer")
  })

  it("picks up a same-size edit even when the mtime does not move (FUSE shares can keep it)", () => {
    expect(loadPsycheAt(root).tacitKnowledge).toBe("tacit one")
    const before = fs.statSync(path.join(root, "psyche/TACIT.md"))
    write("psyche/TACIT.md", "tacit two")
    fs.utimesSync(path.join(root, "psyche/TACIT.md"), before.atime, before.mtime)
    expect(loadPsycheAt(root).tacitKnowledge).toBe("tacit two")
  })

  it("tells an empty file from an absent one", () => {
    write("psyche/LORE.md", "")
    expect(loadPsycheAt(root).lore).toBe("")
    fs.rmSync(path.join(root, "psyche/LORE.md"))
    write("psyche/LORE.md", "lore")
    expect(loadPsycheAt(root).lore).toBe("lore")
  })

  it("picks up a file that is deleted, then recreated", () => {
    expect(loadPsycheAt(root).soul).toBe("soul one")
    fs.rmSync(path.join(root, "psyche/SOUL.md"))
    expect(loadPsycheAt(root).soul).toBe("")
    write("psyche/SOUL.md", "soul again")
    expect(loadPsycheAt(root).soul).toBe("soul again")
  })

  it("picks up a file that appears where there was none", () => {
    expect(loadPsycheAt(root).lore).toBe("")
    write("psyche/LORE.md", "lore arrives")
    expect(loadPsycheAt(root).lore).toBe("lore arrives")
  })

  it("picks up an atomic rename over the file, the way git checkout writes it", () => {
    expect(loadPsycheAt(root).soul).toBe("soul one")
    write("psyche/.SOUL.md.tmp", "soul from git")
    fs.renameSync(path.join(root, "psyche/.SOUL.md.tmp"), path.join(root, "psyche/SOUL.md"))
    expect(loadPsycheAt(root).soul).toBe("soul from git")
  })

  it("picks up a change to the house file and the house names", () => {
    write("psyche/IDENTITY.md", "I am {{butler}}")
    expect(loadPsycheAt(root).identity).not.toContain("Jeeves")
    write("house/house.json", JSON.stringify({ butlerName: "Jeeves" }))
    expect(loadPsycheAt(root).identity).toBe("I am Jeeves")
    write("house/HOUSE.md", "the house")
    expect(loadPsycheAt(root).house).toBe("the house")
  })

  it("reads product/PRODUCT.md into the psyche and picks up an edit", () => {
    write("product/PRODUCT.md", "rules one")
    expect(loadPsycheAt(root).product).toBe("rules one")
    write("product/PRODUCT.md", "rules two")
    expect(loadPsycheAt(root).product).toBe("rules two")
  })

  it("has no product text when the file is absent or empty", () => {
    expect(loadPsycheAt(root).product).toBe("")
    write("product/PRODUCT.md", "")
    expect(loadPsycheAt(root).product).toBe("")
  })

  it("fills house names in the product text", () => {
    write("house/house.json", JSON.stringify({ ownerName: "Ada" }))
    write("product/PRODUCT.md", "{{owner}}")
    expect(loadPsycheAt(root).product).toBe("Ada")
  })

  it("keeps each agent's psyche apart", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "psyche-reload-other-"))
    try {
      fs.mkdirSync(path.join(other, "psyche"))
      fs.writeFileSync(path.join(other, "psyche/SOUL.md"), "other soul")
      expect(loadPsycheAt(root).soul).toBe("soul one")
      expect(loadPsycheAt(other).soul).toBe("other soul")
      expect(loadPsycheAt(root).soul).toBe("soul one")
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})
