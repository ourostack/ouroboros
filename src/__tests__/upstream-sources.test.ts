import { createHash } from "crypto"
import { existsSync, readFileSync, readdirSync } from "fs"
import { join, resolve } from "path"
import { describe, expect, it } from "vitest"

const root = resolve(__dirname, "../..")

interface LockFile {
  path: string
  sha256: string
}

function readLock(): { commit: string; files: LockFile[] } {
  const lock = JSON.parse(readFileSync(join(root, "upstream-sources.lock.json"), "utf8")) as {
    sources: Array<{ commit: string; files: Array<{ generatedPath: string; sha256: string }> }>
  }
  const [source] = lock.sources
  return {
    commit: source.commit,
    files: source.files.map((file) => ({ path: file.generatedPath, sha256: file.sha256 })),
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

describe("upstream-sources.lock.json", () => {
  const lock = readLock()

  it("pins the Ouro AX kit to a full commit sha", () => {
    expect(lock.commit).toMatch(/^[0-9a-f]{40}$/)
  })

  it.each(lock.files.map((file) => [file.path, file] as const))("%s matches its pinned sha256", (_path, file) => {
    const absolute = join(root, file.path)
    expect(existsSync(absolute)).toBe(true)
    expect(sha256(absolute)).toBe(file.sha256)
  })

  it("lists every vendored AX kit file, and no test or fixture", () => {
    const vendored = readdirSync(join(root, "lib/ouro-ui/registry/ouro/ax"))
      .filter((name) => /\.m?ts$/.test(name))
      .map((name) => `lib/ouro-ui/registry/ouro/ax/${name}`)
      .sort()
    const listed = lock.files.map((file) => file.path).filter((path) => path.includes("/registry/ouro/ax/")).sort()
    expect(listed).toEqual(vendored)
    expect(listed.some((path) => /\.test\.|fixtures/.test(path))).toBe(false)
  })
})
