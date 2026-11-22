import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { execFileSync } from "child_process"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

const {
  comparePackedTarballs,
  lookupPublishedVersion,
  publishPackageIdempotently,
} = require(path.resolve(__dirname, "../../../scripts/npm-publish-idempotency.cjs"))

const NAME = "@ouro.bot/cli"
const VERSION = "0.1.0-alpha.1181"
const SPEC = `${NAME}@${VERSION}`
const PACKAGE_JSON = JSON.stringify({ name: NAME, version: VERSION })
const SAME_FILES = { "package.json": PACKAGE_JSON, "dist/cli.js": "console.log('ouro')" }
const CHANGED_FILES = { "package.json": PACKAGE_JSON, "dist/cli.js": "console.log('ouro v2')" }

type NpmResult = { status: number; stdout: string; stderr: string }
const ok = (stdout = ""): NpmResult => ({ status: 0, stdout, stderr: "" })
const fail = (stderr: string): NpmResult => ({ status: 1, stdout: "", stderr })
const NOT_FOUND = fail("npm error code E404\nnpm error 404 No match found for version")
const FORBIDDEN = fail("npm error code E403\nnpm error 403 You cannot publish over the previously published versions")

let work: string

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "npm-publish-idempotency-"))
  fs.writeFileSync(path.join(work, "package.json"), PACKAGE_JSON)
})

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true })
})

function tarball(label: string, files: Record<string, string>): string {
  const root = path.join(work, label)
  for (const [relative, body] of Object.entries(files)) {
    const file = path.join(root, "package", relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
  }
  const out = path.join(work, `${label}.tgz`)
  execFileSync("tar", ["-czf", out, "-C", root, "package"])
  return out
}

// Stands in for the npm CLI. `remote` is what the registry holds for SPEC; `publish`
// may change it, the way a real PUT (or a retry after a PUT that landed) would.
function fakeNpm(options: {
  local: string
  remote: string | null
  lookupFailure?: string
  publish?: () => NpmResult
}) {
  const calls: string[][] = []
  const state = { remote: options.remote }
  const npm = (args: string[]): NpmResult => {
    calls.push(args)
    const [command] = args
    if (command === "view") {
      if (options.lookupFailure) return fail(options.lookupFailure)
      return state.remote ? ok(JSON.stringify(VERSION)) : NOT_FOUND
    }
    if (command === "publish") {
      return options.publish ? options.publish() : ok()
    }
    if (command === "pack") {
      const destination = args[args.indexOf("--pack-destination") + 1]
      const source = args.includes("--ignore-scripts") ? options.local : state.remote
      if (!source) return NOT_FOUND
      fs.copyFileSync(source, path.join(destination, path.basename(source)))
      return ok(JSON.stringify([{ filename: path.basename(source) }]))
    }
    throw new Error(`unexpected npm ${args.join(" ")}`)
  }
  return { npm, calls, state }
}

const publishCalls = (calls: string[][]) => calls.filter(([command]) => command === "publish")

describe("npm publish idempotency", () => {
  it("publishes when the exact version is absent from npm", () => {
    const local = tarball("local", SAME_FILES)
    const fake = fakeNpm({ local, remote: null, publish: () => {
      fake.state.remote = local
      return ok()
    } })

    expect(publishPackageIdempotently({ cwd: work, tag: "latest" }, fake.npm)).toEqual({
      outcome: "published",
      spec: SPEC,
    })
    expect(publishCalls(fake.calls)).toEqual([["publish", "--access", "public", "--tag", "latest"]])
  })

  it("skips without publishing when npm already holds identical contents", () => {
    const local = tarball("local", SAME_FILES)
    const fake = fakeNpm({ local, remote: tarball("remote", SAME_FILES) })

    expect(publishPackageIdempotently({ cwd: work, tag: "latest" }, fake.npm)).toEqual({
      outcome: "already-published",
      spec: SPEC,
    })
    expect(publishCalls(fake.calls)).toEqual([])
  })

  it("fails on a real content conflict instead of skipping the new artifact", () => {
    const local = tarball("local", SAME_FILES)
    const fake = fakeNpm({ local, remote: tarball("remote", CHANGED_FILES) })

    expect(() => publishPackageIdempotently({ cwd: work, tag: "latest" }, fake.npm))
      .toThrow(`${SPEC} is already on npm with different contents: content differs: dist/cli.js`)
    expect(publishCalls(fake.calls)).toEqual([])
  })

  it("does not treat a failed registry lookup as absence", () => {
    const local = tarball("local", SAME_FILES)
    const fake = fakeNpm({ local, remote: null, lookupFailure: "npm error code ETIMEDOUT" })

    expect(() => publishPackageIdempotently({ cwd: work, tag: "latest" }, fake.npm))
      .toThrow(`could not read ${SPEC} from npm`)
    expect(publishCalls(fake.calls)).toEqual([])
    expect(() => lookupPublishedVersion(SPEC, fake.npm)).toThrow("could not read")
  })

  it("passes when a publish fails after identical contents already landed (the E403 retry)", () => {
    const local = tarball("local", SAME_FILES)
    const landed = tarball("landed", SAME_FILES)
    const fake = fakeNpm({ local, remote: null, publish: () => {
      fake.state.remote = landed
      return FORBIDDEN
    } })

    expect(publishPackageIdempotently({ cwd: work, tag: "latest" }, fake.npm)).toEqual({
      outcome: "already-published",
      spec: SPEC,
    })
    expect(publishCalls(fake.calls)).toHaveLength(1)
  })

  it("fails when a publish error leaves different contents on npm", () => {
    const local = tarball("local", SAME_FILES)
    const landed = tarball("landed", CHANGED_FILES)
    const fake = fakeNpm({ local, remote: null, publish: () => {
      fake.state.remote = landed
      return FORBIDDEN
    } })

    expect(() => publishPackageIdempotently({ cwd: work, tag: "latest" }, fake.npm))
      .toThrow(`${SPEC} is already on npm with different contents`)
  })

  it("rethrows the publish error when npm still has no such version", () => {
    const local = tarball("local", SAME_FILES)
    const fake = fakeNpm({ local, remote: null, publish: () => fail("npm error code E500 boom") })

    expect(() => publishPackageIdempotently({ cwd: work, tag: "latest" }, fake.npm))
      .toThrow(`npm publish ${SPEC} failed: npm error code E500 boom`)
  })

  describe("E409 while the staged version is not yet readable", () => {
    const STAGED = fail("npm error code E409\nnpm error Cannot publish over previously staged version")
    const noSleep = { attempts: 3, intervalMs: 0, sleep: () => {} }

    function stagedFake(landed: string | null, local: string, rejection: NpmResult = STAGED) {
      let views = 0
      const fake = fakeNpm({ local, remote: null, publish: () => rejection })
      const inner = fake.npm
      const npm = (args: string[]): NpmResult => {
        if (args[0] === "view" && ++views >= 4) fake.state.remote = landed
        return inner(args)
      }
      return { ...fake, npm }
    }

    it("accepts identical contents once the staged version becomes readable", () => {
      const local = tarball("local", SAME_FILES)
      const fake = stagedFake(tarball("landed", SAME_FILES), local)
      expect(publishPackageIdempotently({ cwd: work, tag: "latest" }, fake.npm, noSleep))
        .toEqual({ outcome: "already-published", spec: SPEC })
      expect(publishCalls(fake.calls)).toHaveLength(1)
    })

    it("also waits on E403 over a previously published version that is not yet readable", () => {
      const local = tarball("local", SAME_FILES)
      const fake = stagedFake(tarball("landed", SAME_FILES), local, FORBIDDEN)
      expect(publishPackageIdempotently({ cwd: work, tag: "latest" }, fake.npm, noSleep))
        .toEqual({ outcome: "already-published", spec: SPEC })
    })

    it("does not wait on a generic E403 policy or auth denial", () => {
      const local = tarball("local", SAME_FILES)
      const fake = stagedFake(tarball("landed", SAME_FILES), local, fail("npm error code E403\nnpm error 403 Forbidden - token lacks permission"))
      expect(() => publishPackageIdempotently({ cwd: work, tag: "latest" }, fake.npm, noSleep))
        .toThrow(`npm publish ${SPEC} failed: npm error code E403`)
    })

    it("fails on different contents after the wait instead of accepting E409", () => {
      const local = tarball("local", SAME_FILES)
      const fake = stagedFake(tarball("landed", CHANGED_FILES), local)
      expect(() => publishPackageIdempotently({ cwd: work, tag: "latest" }, fake.npm, noSleep))
        .toThrow(`${SPEC} is already on npm with different contents: content differs: dist/cli.js`)
    })

    it("fails saying it is staged but unreadable when it never appears", () => {
      const local = tarball("local", SAME_FILES)
      const fake = stagedFake(null, local)
      expect(() => publishPackageIdempotently({ cwd: work, tag: "latest" }, fake.npm, noSleep))
        .toThrow("published or staged by another publish but still unreadable after 3 polls")
    })

    it("surfaces a registry read error during the wait", () => {
      const local = tarball("local", SAME_FILES)
      let views = 0
      // view 1 is the initial lookup, view 2 the immediate post-publish read; the third is inside the wait.
      const fake = fakeNpm({ local, remote: null, publish: () => STAGED })
      const npm = (args: string[]): NpmResult =>
        args[0] === "view" && ++views >= 3 ? fail("npm error code ETIMEDOUT") : fake.npm(args)
      expect(() => publishPackageIdempotently({ cwd: work, tag: "latest" }, npm, noSleep))
        .toThrow(`could not read ${SPEC} from npm`)
    })
  })
})
