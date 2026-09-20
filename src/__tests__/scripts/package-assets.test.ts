import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import * as vm from "node:vm"

const {
  REQUIRED_PACKAGE_ASSET_PATHS,
  DISALLOWED_PACKAGE_ASSET_PATH_PREFIXES,
  DISALLOWED_PACKAGE_ASSET_TEXT_PATTERNS,
  IGNORED_LOCAL_PACKAGE_ASSET_PATH_PREFIXES,
  PACKAGE_PAYLOAD_FILE_PATHS,
  PACKAGE_PAYLOAD_PATH_PREFIXES,
  listPackageFiles,
  packageRootFromBinPath,
  runPackageAssetsCli,
  validatePackageAssets,
} = createRequire(path.resolve("scripts/package-assets.cjs"))("./package-assets.cjs")

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-package-assets-test-"))
  roots.push(root)
  return root
}

function writeFile(root: string, relativePath: string, content = "ok"): void {
  const filePath = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function writeRequiredAssets(root: string): void {
  for (const relativePath of REQUIRED_PACKAGE_ASSET_PATHS) {
    writeFile(root, relativePath)
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe("package asset validation", () => {
  it("runs the native CLI main with default argv and both real output adapters", () => {
    const filename = path.resolve("scripts/package-assets.cjs")
    const source = fs.readFileSync(filename, "utf8")
    const root = makeRoot()
    writeRequiredAssets(root)
    for (const valid of [true, false]) {
      if (!valid) fs.unlinkSync(path.join(root, "deploy/unraid/sanctuary-authority-service.sh"))
      const stdout: string[] = []
      const stderr: string[] = []
      const entryModule = { exports: {} }
      const nativeRequire = createRequire(filename)
      const runtime = { argv: ["node", filename, root], cwd: () => root, exitCode: undefined as number | undefined, stdout: { write: (text: string) => stdout.push(text) }, stderr: { write: (text: string) => stderr.push(text) } }
      vm.runInNewContext(source, { require: Object.assign((id: string) => nativeRequire(id), { main: entryModule }), module: entryModule, process: runtime }, { filename })
      expect(runtime.exitCode).toBe(valid ? 0 : 1)
      expect(stdout.join("")).toBe(valid ? "package assets verified\n" : "")
      expect(stderr.join("")).toBe(valid ? "" : "missing required package assets: deploy/unraid/sanctuary-authority-service.sh\n")
    }
  })

  it("uses cwd with default dependencies and scans both missing and disallowed payloads", () => {
    const root = makeRoot()
    writeRequiredAssets(root)
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root)
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true)
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    try {
      expect(runPackageAssetsCli([])).toBe(0)
      fs.unlinkSync(path.join(root, "deploy/unraid/sanctuary-authority-service.sh"))
      writeFile(root, "dist/outlook-ui/index.js", "obsolete")
      expect(runPackageAssetsCli([])).toBe(1)
      expect(err).toHaveBeenCalledWith(expect.stringContaining("; disallowed package assets:"))
    } finally { cwd.mockRestore(); out.mockRestore(); err.mockRestore() }
  })

  it("characterizes unreadable text, non-files, missing roots and failed realpath without excluding native code", () => {
    const root = makeRoot()
    writeRequiredAssets(root)
    const deps = { ...fs, ...path, readFileSync: () => { throw new Error("unreadable") } }
    expect(validatePackageAssets(root, deps).ok).toBe(true)
    expect(listPackageFiles(path.join(root, "missing"))).toEqual([])
    fs.symlinkSync("missing", path.join(root, "assets", "not-a-file"))
    expect(listPackageFiles(root)).not.toContain("assets/not-a-file")
    const bin = path.join(root, "dist", "ouro")
    writeFile(root, "package.json", JSON.stringify({ name: "@ouro.bot/cli" }))
    writeFile(root, "dist/ouro", "entry")
    expect(packageRootFromBinPath(bin, undefined, { ...fs, ...path, realpathSync: () => { throw new Error("not a link") } })).toBe(root)
  })

  it.each([
    ["sanctuary-authority-root-lifecycle", "daemon"],
    ["sanctuary-telegram-authority-entry", "daemon"],
    ["sanctuary-host-supervisor-entry", "daemon"],
  ])("keeps compiled %s mandatory outside explicit source-tree checks", (name, directory) => {
    const root = makeRoot()
    writeRequiredAssets(root)
    const compiled = `dist/heart/${directory}/${name}.js`
    fs.unlinkSync(path.join(root, compiled))
    writeFile(root, `src/heart/${directory}/${name}.ts`, "export {}")
    expect(validatePackageAssets(root).missing).toContain(compiled)
    expect(validatePackageAssets(root, undefined, { sourceTree: true }).ok).toBe(true)
  })
  it("requires the complete compiled root lifecycle entry surface, not just deployment scripts", () => {
    for (const asset of [
      "dist/heart/daemon/sanctuary-authority-root-lifecycle.js",
      "dist/heart/daemon/sanctuary-telegram-authority-entry.js",
      "dist/heart/daemon/sanctuary-host-supervisor-entry.js",
      "assets/sanctuary-host-launcher.sh",
      "deploy/unraid/sanctuary-authority-service.sh",
      "deploy/unraid/sanctuary-authority-installation.json",
    ]) expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain(asset)
    expect(fs.readFileSync("deploy/unraid/Dockerfile", "utf8")).toContain("COPY assets/sanctuary-host-launcher.sh /opt/ouro/deploy/unraid/sanctuary-host-launcher.sh")
  })
  it("documents owner-only sequential Jellyfin provisioning without installation authority or weak rollback", () => {
    const readme = fs.readFileSync("deploy/unraid/README.txt", "utf8")
    const heading = "Bounded Jellyfin stewardship"
    expect(readme).toContain(heading)
    const section = readme.slice(readme.indexOf(heading))
    for (const requirement of [
      "fresh authenticated owner Telegram message after installation",
      "set_desired_state -> read -> grant_routine_action -> read",
      "container:jellyfin=on", "unraid.restart:jellyfin", "unraid.container.restart",
      "2 attempts per 1800000 ms", "365 days after authorization",
      "verificationRequired=true", "exclusions=[]", "provenance=stated",
      "Packaged desired states and grants remain empty",
      "Do not start a weak predecessor after policy exists",
      "state/policy/policy-audit.ndjson", "state/policy/action-receipts.ndjson",
    ]) expect(section).toContain(requirement)
  })

  it("ships the owner v8 identity correction without changing any other psyche content or containment source", () => {
    const root = path.resolve("deploy/unraid")
    const identity = fs.readFileSync(path.join(root, "sanctuary.ouro/psyche/IDENTITY.md"), "utf8")
    const oldSentence = "My primary server interface is the typed Unraid GraphQL repertoire, never shell."
    const newSentence = "I use the typed Unraid GraphQL repertoire for server operations and owner-authorized native tools for resident work inside my existing container boundary."
    expect(identity).toContain(newSentence)
    expect(createHash("sha256").update(identity.replace(newSentence, oldSentence)).digest("hex")).toBe("024a02ad975deadb6d22afd4b0683047210a993e00f73d9f7f499898c6229590")
    for (const [name, expected] of Object.entries({
      "ASPIRATIONS.md": "2a0ab1c8084e0d703ea614341d08f041e01dbd50c4d2dec347b955c3a29a4c94",
      "LORE.md": "d7669b393f34565e6ce4abe326f1443227acd6afd1dd49161c6d19645ac0a4a7",
      "SOUL.md": "35c7c22c6ce9627db3a72ade5b6132fa9ec5f51b45ebd10d7f8906154b54019a",
      "TACIT.md": "858b79b2b5dc2df63b20ef611ee873d1491aab075120faac8dd22cd57d7fcf83",
    })) expect(createHash("sha256").update(fs.readFileSync(path.join(root, "sanctuary.ouro/psyche", name))).digest("hex")).toBe(expected)
    const contract = JSON.parse(fs.readFileSync(path.join(root, "sanctuary-acceptance-contract.json"), "utf8"))
    expect(JSON.stringify(contract.scenarioSources["containment-audit"])).toContain("sanctuary-containment-audit-v2")
  })

  it("allows only an explicit source-checkout validation before compilation while packed assets remain strict", () => {
    const root = makeRoot()
    writeRequiredAssets(root)
    const compiled = "dist/heart/session-redaction-repair-cli-main.js"
    const source = "src/heart/session-redaction-repair-cli-main.ts"
    fs.unlinkSync(path.join(root, compiled))
    writeFile(root, source, "export {}")
    expect(validatePackageAssets(root).missing).toContain(compiled)
    expect(validatePackageAssets(root, undefined, { sourceTree: true })).toMatchObject({
      ok: true,
      missing: [],
      message: expect.stringContaining("source checkout"),
    })
    expect(validatePackageAssets(root, undefined, { sourceTree: false }).missing).toContain(compiled)
    fs.unlinkSync(path.join(root, source))
    expect(validatePackageAssets(root, undefined, { sourceTree: true }).missing).toContain(compiled)
  })

  it.each([null, {}, { sourceTree: undefined }, { sourceTree: null }, { sourceTree: "true" }, { sourceTree: 1 }])(
    "keeps package validation strict for inactive or malformed source options %j",
    (options) => {
      const root = makeRoot()
      writeRequiredAssets(root)
      const compiled = "dist/heart/session-redaction-repair-cli-main.js"
      fs.unlinkSync(path.join(root, compiled))
      writeFile(root, "src/heart/session-redaction-repair-cli-main.ts", "export {}")
      expect(validatePackageAssets(root, undefined, options).missing).toContain(compiled)
    },
  )

  it.each(["missing", "directory"])("refuses a %s cold-checkout source asset", (kind) => {
    const root = makeRoot()
    writeRequiredAssets(root)
    const compiled = "dist/heart/session-redaction-repair-cli-main.js"
    fs.unlinkSync(path.join(root, compiled))
    if (kind === "directory") {
      fs.mkdirSync(path.join(root, "src/heart/session-redaction-repair-cli-main.ts"), { recursive: true })
    }
    expect(validatePackageAssets(root, undefined, { sourceTree: true }).missing).toContain(compiled)
  })

  it("does not accept a symlink as a cold-checkout source asset", () => {
    const root = makeRoot()
    writeRequiredAssets(root)
    const compiled = "dist/heart/session-redaction-repair-cli-main.js"
    const source = path.join(root, "src/heart/session-redaction-repair-cli-main.ts")
    fs.unlinkSync(path.join(root, compiled))
    fs.mkdirSync(path.dirname(source), { recursive: true })
    writeFile(root, "outside.ts", "export {}")
    fs.symlinkSync(path.join(root, "outside.ts"), source)
    expect(validatePackageAssets(root, undefined, { sourceTree: true }).missing).toContain(compiled)
  })

  it("keeps other required assets and disallowed payload checks active in source mode", () => {
    const root = makeRoot()
    writeRequiredAssets(root)
    fs.unlinkSync(path.join(root, "dist/heart/session-redaction-repair-cli-main.js"))
    writeFile(root, "src/heart/session-redaction-repair-cli-main.ts", "export {}")
    fs.unlinkSync(path.join(root, "assets/bluebubbles-host"))
    writeFile(root, "dist/outlook-ui/index.js", "obsolete")
    expect(validatePackageAssets(root, undefined, { sourceTree: true })).toMatchObject({
      ok: false,
      missing: ["assets/bluebubbles-host"],
      disallowed: ["dist/outlook-ui/index.js"],
    })
  })

  it("A003 has no production repertoire registration", async () => {
    const { getToolsForChannel, resolveToolDefinition } = await import("../../repertoire/tools")
    const names = getToolsForChannel().map((tool) => tool.function.name)
    expect(names.length).toBeGreaterThan(0)
    expect(names).not.toContain("session_redaction_repair")
    expect(names).not.toContain("selectA003LegacyRequiredCorrections")
    expect(resolveToolDefinition("session_redaction_repair")).toBeUndefined()
    expect(resolveToolDefinition("session-redaction-repair")).toBeUndefined()
  })
  it("A003 declares the direct maintenance entrypoint without public package or command routing", () => {
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("dist/heart/session-redaction-repair-cli-main.js")
    const root = path.resolve(".")
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
    expect(JSON.stringify([pkg.bin, pkg.exports])).not.toContain("session-redaction-repair")
    for (const file of ["src/heart/daemon/daemon-cli.ts", "src/heart/daemon/daemon.ts", "src/repertoire/tools.ts", "src/senses/telegram.ts"]) {
      expect(fs.readFileSync(path.join(root, file), "utf8")).not.toMatch(/session-redaction-repair|a003-sanctuary-session-repair/)
    }
    expect(fs.lstatSync(path.join(root, "src/heart/session-redaction-repair-cli-main.ts")).isFile()).toBe(true)
  })
  it("declares RepairGuide files as required package assets", () => {
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("assets/bluebubbles-host")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("RepairGuide.ouro/agent.json")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("RepairGuide.ouro/psyche/IDENTITY.md")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("RepairGuide.ouro/psyche/SOUL.md")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("RepairGuide.ouro/skills/diagnose-vault-expired.md")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/sanctuary.ouro/agent.json")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/sanctuary.ouro/bundle-meta.json")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/sanctuary.ouro/provider-readiness.json")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/sanctuary.ouro/tool-profiles.json")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/sanctuary.ouro/state/policy/steward.json")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/migrate-sanctuary-bundle.mjs")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/docker-man-template-transaction.mjs")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/docker-man-template-xml.cjs")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/sanctuary.xml")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/ouro-events/emit-event.mjs")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/ouro-events/bootstrap-spool.sh")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/ouro-events/emit-usenet-event.sh")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/ouro-events/usenet-health.sh")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/ouro-events/install-usenet-guard.sh")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/sanctuary-acceptance-harness.sh")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/sanctuary-unit16-host-broker.mjs")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/sanctuary-deployment-target.mjs")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/sanctuary-unit18-target-audit.sh")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/sanctuary-unit16-run.sh")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/README.txt")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/sanctuary.ouro/psyche/SOUL.md")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("deploy/unraid/sanctuary.ouro/psyche/IDENTITY.md")
  })

  it("ships no restart authority or fabricated owner session identity", () => {
    const policy = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary.ouro/state/policy/steward.json", "utf8"))
    expect(policy.desiredStates).toEqual({})
    expect(policy.routineActionGrants).toEqual({})
    expect(JSON.stringify(policy)).not.toContain("owner-contract")
    expect(JSON.stringify(policy)).not.toContain('"issuer":"ari"')
  })

  it("declares stale nested Mailbox UI dist as disallowed", () => {
    expect(DISALLOWED_PACKAGE_ASSET_PATH_PREFIXES).toContain("dist/mailbox-ui/dist/")
    expect(DISALLOWED_PACKAGE_ASSET_PATH_PREFIXES).toContain("dist/outlook-ui/")
  })

  it("declares removed provider package text as disallowed", () => {
    expect(DISALLOWED_PACKAGE_ASSET_TEXT_PATTERNS.map((entry: { label: string }) => entry.label)).toEqual([
      "removed provider selection file",
      "removed provider state module",
      "removed drift module",
      "removed BlueBubbles timeout notice",
    ])
  })

  it("declares local-only package asset roots as ignored", () => {
    expect(IGNORED_LOCAL_PACKAGE_ASSET_PATH_PREFIXES).toEqual([
      ".git/",
      "coverage/",
      "node_modules/",
    ])
  })

  it("declares package payload roots that are safe to scan before npm pack", () => {
    expect(PACKAGE_PAYLOAD_PATH_PREFIXES).toEqual([
      "assets/",
      "deploy/unraid/",
      "dist/",
      "RepairGuide.ouro/",
      "SerpentGuide.ouro/",
      "skills/",
    ])
    expect(PACKAGE_PAYLOAD_FILE_PATHS).toEqual([
      "changelog.json",
      "npm-shrinkwrap.json",
      "package.json",
    ])
  })

  it("passes when required assets are present and no stale paths exist", () => {
    const root = makeRoot()
    writeRequiredAssets(root)
    writeFile(root, "dist/mailbox-ui/index.html")
    writeFile(root, "dist/mailbox-ui/assets/index.js")

    const result = validatePackageAssets(root)

    expect(result).toEqual({
      ok: true,
      packageRoot: root,
      missing: [],
      disallowed: [],
      message: "package assets verified",
    })
  })

  it("lists package files recursively and ignores non-file entries", () => {
    const root = makeRoot()
    writeFile(root, "dist/b/file.txt")
    writeFile(root, "dist/a/file.txt")
    fs.symlinkSync(path.join(root, "dist", "a", "file.txt"), path.join(root, "dist", "linked-file.txt"))

    expect(listPackageFiles(root)).toEqual([
      "dist/a/file.txt",
      "dist/b/file.txt",
    ])
  })

  it("does not scan local build and dependency artifacts", () => {
    const root = makeRoot()
    writeFile(root, "dist/current.js")
    writeFile(root, "coverage/lcov-report/stale.html")
    writeFile(root, "node_modules/package/stale.js")
    writeFile(root, ".git/objects/stale")
    writeFile(root, ".claude/worktrees/old/dist/stale.js")
    writeFile(root, "src/senses/bluebubbles/index.ts")
    writeFile(root, "docs/old.md")
    writeFile(root, "packages/mailbox-ui/dist/stale.js")

    expect(listPackageFiles(root)).toEqual(["dist/current.js"])
  })

  it("treats a missing package root as missing all required package assets", () => {
    const root = path.join(makeRoot(), "missing-root")

    const result = validatePackageAssets(root)

    expect(result.ok).toBe(false)
    expect(result.missing).toEqual([...REQUIRED_PACKAGE_ASSET_PATHS].sort())
    expect(result.disallowed).toEqual([])
  })

  it("fails with clear missing-path messages when required assets are absent", () => {
    const root = makeRoot()
    writeFile(root, "RepairGuide.ouro/agent.json")

    const result = validatePackageAssets(root)

    expect(result.ok).toBe(false)
    expect(result.missing).toContain("RepairGuide.ouro/psyche/IDENTITY.md")
    expect(result.message).toContain("missing required package assets")
    expect(result.message).toContain("RepairGuide.ouro/psyche/IDENTITY.md")
  })

  it("fails with clear disallowed-path messages when stale Mailbox UI output is present", () => {
    const root = makeRoot()
    writeRequiredAssets(root)
    writeFile(root, "dist/mailbox-ui/dist/index.html")
    writeFile(root, "dist/mailbox-ui/dist/assets/old.js")

    const result = validatePackageAssets(root)

    expect(result.ok).toBe(false)
    expect(result.disallowed).toEqual([
      "dist/mailbox-ui/dist/assets/old.js",
      "dist/mailbox-ui/dist/index.html",
    ])
    expect(result.message).toContain("disallowed package assets")
    expect(result.message).toContain("dist/mailbox-ui/dist/index.html")
  })

  it("fails when legacy Outlook UI output remains in the package", () => {
    const root = makeRoot()
    writeRequiredAssets(root)
    writeFile(root, "dist/outlook-ui/index.html")

    const result = validatePackageAssets(root)

    expect(result.ok).toBe(false)
    expect(result.disallowed).toEqual(["dist/outlook-ui/index.html"])
    expect(result.message).toContain("dist/outlook-ui/index.html")
  })

  it("fails when removed provider package text remains in package assets", () => {
    const root = makeRoot()
    writeRequiredAssets(root)
    const removedProviderSelectionFile = ["providers", "json"].join(".")
    const removedProviderModule = ["provider", "state"].join("-")
    const removedDriftModule = ["drift", "detection"].join("-")
    writeFile(root, "dist/nerves/coverage/file-completeness.js", `"daemon/${removedDriftModule}"`)
    writeFile(root, "dist/heart/daemon/doctor.js", `"state/${removedProviderSelectionFile}"`)
    writeFile(root, "dist/heart/provider-binding-resolver.js", `require("./${removedProviderModule}")`)

    const result = validatePackageAssets(root)

    expect(result.ok).toBe(false)
    expect(result.disallowed).toEqual([
      "dist/heart/daemon/doctor.js contains removed provider selection file",
      "dist/heart/provider-binding-resolver.js contains removed provider state module",
      "dist/nerves/coverage/file-completeness.js contains removed drift module",
    ])
  })

  it("fails when removed BlueBubbles timeout notice remains in package assets", () => {
    const root = makeRoot()
    writeRequiredAssets(root)
    writeFile(
      root,
      "dist/senses/bluebubbles/index.js",
      '"live iMessage turn timed out; I captured it for recovery instead of silently hanging"',
    )

    const result = validatePackageAssets(root)

    expect(result.ok).toBe(false)
    expect(result.disallowed).toEqual([
      "dist/senses/bluebubbles/index.js contains removed BlueBubbles timeout notice",
    ])
  })

  it("ignores removed BlueBubbles timeout notice in local artifacts outside the package payload", () => {
    const root = makeRoot()
    writeRequiredAssets(root)
    writeFile(
      root,
      ".claude/worktrees/bb-inflight-ttl/dist/senses/bluebubbles/index.js",
      '"live iMessage turn timed out; I captured it for recovery instead of silently hanging"',
    )
    writeFile(
      root,
      ".claude/worktrees/bb-inflight-ttl/coverage/lcov-report/senses/bluebubbles/index.ts.html",
      '"live iMessage turn timed out; I captured it for recovery instead of silently hanging"',
    )
    writeFile(
      root,
      "src/senses/bluebubbles/index.ts",
      '"live iMessage turn timed out; I captured it for recovery instead of silently hanging"',
    )

    const result = validatePackageAssets(root)

    expect(result).toEqual({
      ok: true,
      packageRoot: root,
      missing: [],
      disallowed: [],
      message: "package assets verified",
    })
  })

  it("returns success from the package asset CLI for a clean package root", () => {
    const root = makeRoot()
    writeRequiredAssets(root)
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = runPackageAssetsCli([root], {
      cwd: () => root,
      dirname: path.dirname,
      existsSync: fs.existsSync,
      join: path.join,
      readFileSync: fs.readFileSync,
      readdirSync: fs.readdirSync,
      realpathSync: fs.realpathSync,
      resolve: path.resolve,
      statSync: fs.statSync,
      writeStderr: (text: string) => stderr.push(text),
      writeStdout: (text: string) => stdout.push(text),
    })

    expect(exitCode).toBe(0)
    expect(stdout.join("")).toBe("package assets verified\n")
    expect(stderr.join("")).toBe("")
  })

  it("returns failure from the package asset CLI for stale package roots", () => {
    const root = makeRoot()
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = runPackageAssetsCli([root], {
      cwd: () => root,
      dirname: path.dirname,
      existsSync: fs.existsSync,
      join: path.join,
      readFileSync: fs.readFileSync,
      readdirSync: fs.readdirSync,
      realpathSync: fs.realpathSync,
      resolve: path.resolve,
      statSync: fs.statSync,
      writeStderr: (text: string) => stderr.push(text),
      writeStdout: (text: string) => stdout.push(text),
    })

    expect(exitCode).toBe(1)
    expect(stdout.join("")).toBe("")
    expect(stderr.join("")).toContain("missing required package assets")
  })

  it("derives the package root from a symlinked npm .bin path", () => {
    const root = makeRoot()
    const packageRoot = path.join(root, "node_modules", "@ouro.bot", "cli")
    const binDir = path.join(root, "node_modules", ".bin")
    const entry = path.join(packageRoot, "dist", "heart", "daemon", "ouro-entry.js")
    const bin = path.join(binDir, "ouro")
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.mkdirSync(binDir, { recursive: true })
    writeFile(packageRoot, "package.json", JSON.stringify({ name: "@ouro.bot/cli" }))
    fs.writeFileSync(entry, "#!/usr/bin/env node\n")
    fs.symlinkSync(entry, bin)

    expect(packageRootFromBinPath(bin, "@ouro.bot/cli")).toBe(packageRoot)
  })

  it("derives the scoped package root from a plain npm .bin shim path", () => {
    const root = makeRoot()
    const packageRoot = path.join(root, "node_modules", "@ouro.bot", "cli")
    const bin = path.join(root, "node_modules", ".bin", "ouro")
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    writeFile(packageRoot, "package.json", JSON.stringify({ name: "@ouro.bot/cli" }))
    fs.writeFileSync(bin, "#!/usr/bin/env node\n")

    expect(packageRootFromBinPath(bin, "@ouro.bot/cli")).toBe(packageRoot)
  })

  it("derives the package root from realpath when the bin path is outside node_modules", () => {
    const root = makeRoot()
    const packageRoot = path.join(root, "actual-package")
    const entry = path.join(packageRoot, "dist", "heart", "daemon", "ouro-entry.js")
    const bin = path.join(root, "bin", "ouro")
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    writeFile(packageRoot, "package.json", JSON.stringify({ name: "@ouro.bot/cli" }))
    fs.writeFileSync(entry, "#!/usr/bin/env node\n")
    fs.symlinkSync(entry, bin)

    expect(packageRootFromBinPath(bin, "@ouro.bot/cli")).toBe(fs.realpathSync(packageRoot))
  })

  it("throws clearly when a package root cannot be derived from the bin path", () => {
    const root = makeRoot()
    const bin = path.join(root, "node_modules", ".bin", "ouro")
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, "#!/usr/bin/env node\n")

    expect(() => packageRootFromBinPath(bin, "@ouro.bot/cli")).toThrow(
      `could not derive @ouro.bot/cli package root from ${bin}`,
    )
  })

  it("keeps searching when a nearby package.json belongs to a different package", () => {
    const root = makeRoot()
    const packageRoot = path.join(root, "node_modules", "@ouro.bot", "cli")
    const bin = path.join(root, "node_modules", ".bin", "ouro")
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    writeFile(packageRoot, "package.json", JSON.stringify({ name: "not-ouro" }))
    fs.writeFileSync(bin, "#!/usr/bin/env node\n")

    expect(() => packageRootFromBinPath(bin, "@ouro.bot/cli")).toThrow(
      `could not derive @ouro.bot/cli package root from ${bin}`,
    )
  })

  it("rejects malformed package.json files while deriving package roots", () => {
    const root = makeRoot()
    const packageRoot = path.join(root, "node_modules", "@ouro.bot", "cli")
    const bin = path.join(root, "node_modules", ".bin", "ouro")
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    writeFile(packageRoot, "package.json", "{")
    fs.writeFileSync(bin, "#!/usr/bin/env node\n")

    expect(() => packageRootFromBinPath(bin, "@ouro.bot/cli")).toThrow(
      `could not derive @ouro.bot/cli package root from ${bin}`,
    )
  })

  it("throws clearly when the bin path and fallback package path do not exist", () => {
    const root = makeRoot()
    const bin = path.join(root, "missing", ".bin", "ouro")

    expect(() => packageRootFromBinPath(bin, "@ouro.bot/cli")).toThrow(
      `could not derive @ouro.bot/cli package root from ${bin}`,
    )
  })

  it("stops package root derivation at the filesystem root", () => {
    expect(() => packageRootFromBinPath(path.parse(process.cwd()).root, "@ouro.bot/cli")).toThrow(
      "could not derive @ouro.bot/cli package root",
    )
  })
})
