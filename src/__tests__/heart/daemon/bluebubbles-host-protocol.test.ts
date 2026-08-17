import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, it } from "vitest"
import {
  BLUEBUBBLES_HOST_FRESHNESS_MS,
  BLUEBUBBLES_HOST_HELPER_VERSION,
  BLUEBUBBLES_HOST_PROTOCOL_SCHEMA_VERSION,
  BLUEBUBBLES_HOST_RECEIPTS_DIRECTORY,
  BLUEBUBBLES_HOST_REQUESTS_DIRECTORY,
  BLUEBUBBLES_HOST_SHARED_HELPER,
  BLUEBUBBLES_HOST_SHARED_ROOT,
  blueBubblesHostAttemptPath,
  collectCrossUserBlueBubblesHostAction,
  installBlueBubblesHostSharedHelper,
  publishBlueBubblesHostReceipt,
  requestCrossUserBlueBubblesHostAction,
  validateBlueBubblesHostHelperRequest,
  type BlueBubblesHostProtocolDeps,
  type BlueBubblesHostReceipt,
  type BlueBubblesHostRequest,
} from "../../../heart/daemon/bluebubbles-host"

const NOW = Date.parse("2026-08-17T17:00:00.000Z")
const NONCE = "ab".repeat(32)
const REQUEST_ID = `502-${NONCE}`
const EXPECTED_FRESHNESS_MS = 300_000

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ouro-bluebubbles-protocol-"))
  temporaryRoots.push(root)
  return root
}

function fixture() {
  const root = temporaryRoot()
  const sharedRoot = join(root, "shared")
  const originHomeDir = join(root, "origin")
  const targetHomeDir = "/Users/clawdbot"
  const assetPath = join(root, "bluebubbles-host-asset")
  const helperBytes = "#!/usr/bin/env node\n// generic helper\n"
  const baseDeps = {
    now: () => NOW,
    randomBytes: (size: number) => {
      expect(size).toBe(32)
      return Buffer.from(NONCE, "hex")
    },
    existsSync: (filePath: string) => filePath === targetHomeDir || existsSync(filePath),
    expectedHelperBytes: () => Buffer.from(helperBytes),
    lstatSync: (filePath: string) => filePath === targetHomeDir
      ? { uid: 502, mode: 0o755, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false }
      : lstatSync(filePath),
  }
  writeFileSync(assetPath, helperBytes, { mode: 0o644 })
  for (const directory of [originHomeDir]) {
    mkdirSync(directory, { recursive: true })
  }
  installBlueBubblesHostSharedHelper({ assetPath, sharedRoot })

  return { root, sharedRoot, originHomeDir, targetHomeDir, assetPath, helperBytes, baseDeps }
}

function requestFixture(overrides: Partial<BlueBubblesHostRequest> = {}): BlueBubblesHostRequest {
  return {
    schemaVersion: 1,
    helperVersion: 1,
    requestId: REQUEST_ID,
    nonce: NONCE,
    action: "install",
    username: "clawdbot",
    uid: 502,
    requestedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + EXPECTED_FRESHNESS_MS).toISOString(),
    ...overrides,
  }
}

function receiptFixture(overrides: Partial<BlueBubblesHostReceipt> = {}): BlueBubblesHostReceipt {
  return {
    ...requestFixture(),
    appPath: "/Applications/BlueBubbles.app",
    plistPath: "/Users/clawdbot/Library/LaunchAgents/com.bluebubbles.server.plist",
    launchAgentLabel: "com.bluebubbles.server",
    launchdDomain: "gui/502",
    result: "verified",
    detail: "native LaunchAgent verified",
    verifiedAt: new Date(NOW + 1_000).toISOString(),
    ...overrides,
  }
}

function writeTargetOwnedReceipt(
  sharedRoot: string,
  receipt: BlueBubblesHostReceipt,
  uid = receipt.uid,
): BlueBubblesHostProtocolDeps {
  publishBlueBubblesHostReceipt(receipt, { sharedRoot }, {
    now: () => NOW + 1_000,
    randomBytes: (size) => Buffer.alloc(size, 0xcd),
  })
  return {
    now: () => NOW + 1_000,
    lstatSync: (filePath) => {
      const actual = lstatSync(filePath)
      return filePath.endsWith(`${receipt.requestId}.json`)
        ? {
            uid,
            mode: actual.mode,
            isSymbolicLink: () => actual.isSymbolicLink(),
            isDirectory: () => actual.isDirectory(),
            isFile: () => actual.isFile(),
          }
        : actual
    },
  }
}

function virtualProtocolDeps(defaultUid = 501) {
  const files = new Map<string, Buffer>()
  const modes = new Map<string, number>()
  const owners = new Map<string, number>()
  const symlinks = new Set<string>()
  const exists = (filePath: string) => files.has(filePath) || modes.has(filePath)
  const eexist = () => Object.assign(new Error("EEXIST"), { code: "EEXIST" })
  const deps: BlueBubblesHostProtocolDeps = {
    now: () => NOW,
    randomBytes: (size) => Buffer.alloc(size, 0xab),
    currentUid: () => defaultUid,
    expectedHelperBytes: () => Buffer.from("helper"),
    existsSync: exists,
    readFileSync: (filePath) => {
      const value = files.get(filePath)
      if (!value) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      return value
    },
    mkdirSync: (directoryPath, options) => { modes.set(directoryPath, options.mode ?? 0o777) },
    chmodSync: (filePath, mode) => { modes.set(filePath, mode) },
    writeFileSync: (filePath, content, options) => {
      if (options.flag === "wx" && exists(filePath)) throw eexist()
      files.set(filePath, Buffer.isBuffer(content) ? content : Buffer.from(content))
      modes.set(filePath, options.mode)
    },
    linkSync: (existingPath, newPath) => {
      if (exists(newPath)) throw eexist()
      files.set(newPath, Buffer.from(files.get(existingPath)!))
      modes.set(newPath, modes.get(existingPath)!)
    },
    unlinkSync: (filePath) => { files.delete(filePath); modes.delete(filePath) },
    renameSync: (oldPath, newPath) => {
      files.set(newPath, Buffer.from(files.get(oldPath)!))
      modes.set(newPath, modes.get(oldPath)!)
      files.delete(oldPath)
      modes.delete(oldPath)
    },
    lstatSync: (filePath) => ({
      uid: owners.get(filePath) ?? defaultUid,
      mode: modes.get(filePath) ?? 0,
      isSymbolicLink: () => symlinks.has(filePath),
      isDirectory: () => !files.has(filePath),
      isFile: () => files.has(filePath),
    }),
  }
  return { deps, files, modes, owners, symlinks }
}

describe("cross-user BlueBubbles host protocol", () => {
  it("locks the shared protocol paths, schema, helper version, and freshness bound", () => {
    expect(BLUEBUBBLES_HOST_PROTOCOL_SCHEMA_VERSION).toBe(1)
    expect(BLUEBUBBLES_HOST_HELPER_VERSION).toBe(1)
    expect(BLUEBUBBLES_HOST_FRESHNESS_MS).toBe(300_000)
    expect(BLUEBUBBLES_HOST_SHARED_ROOT).toBe("/Users/Shared/Ouro")
    expect(BLUEBUBBLES_HOST_SHARED_HELPER).toBe("/Users/Shared/Ouro/bluebubbles-host")
    expect(BLUEBUBBLES_HOST_REQUESTS_DIRECTORY).toBe("/Users/Shared/Ouro/bluebubbles-host-requests")
    expect(BLUEBUBBLES_HOST_RECEIPTS_DIRECTORY).toBe("/Users/Shared/Ouro/bluebubbles-host-receipts")
  })

  it("installs byte-identical generic helper state with fixed modes and is idempotent", () => {
    const f = fixture()
    const second = installBlueBubblesHostSharedHelper({ assetPath: f.assetPath, sharedRoot: f.sharedRoot })

    expect(readFileSync(join(f.sharedRoot, "bluebubbles-host"), "utf8")).toBe(f.helperBytes)
    expect(statSync(f.sharedRoot).mode & 0o7777).toBe(0o755)
    expect(statSync(join(f.sharedRoot, "bluebubbles-host")).mode & 0o7777).toBe(0o755)
    expect(statSync(join(f.sharedRoot, "bluebubbles-host-requests")).mode & 0o7777).toBe(0o755)
    expect(statSync(join(f.sharedRoot, "bluebubbles-host-receipts")).mode & 0o7777).toBe(0o1777)
    expect(second).toMatchObject({ changed: false, helperPath: join(f.sharedRoot, "bluebubbles-host") })
  })

  it("repairs helper bytes and modes without touching any credential source", () => {
    const f = fixture()
    const helperPath = join(f.sharedRoot, "bluebubbles-host")
    writeFileSync(helperPath, "stale", { mode: 0o600 })
    chmodSync(join(f.sharedRoot, "bluebubbles-host-receipts"), 0o755)

    const result = installBlueBubblesHostSharedHelper({ assetPath: f.assetPath, sharedRoot: f.sharedRoot })

    expect(result.changed).toBe(true)
    expect(readFileSync(helperPath, "utf8")).toBe(f.helperBytes)
    expect(statSync(helperPath).mode & 0o7777).toBe(0o755)
    expect(statSync(join(f.sharedRoot, "bluebubbles-host-receipts")).mode & 0o7777).toBe(0o1777)
  })

  it("rejects symlink, wrong-owner, and non-directory shared roots", () => {
    const root = temporaryRoot()
    const assetPath = join(root, "asset")
    const realDirectory = join(root, "real")
    const symlinkRoot = join(root, "symlink-root")
    const fileRoot = join(root, "file-root")
    writeFileSync(assetPath, "helper")
    mkdirSync(realDirectory)
    symlinkSync(realDirectory, symlinkRoot)
    writeFileSync(fileRoot, "not a directory")

    expect(() => installBlueBubblesHostSharedHelper({ assetPath, sharedRoot: symlinkRoot })).toThrow(
      "shared root must not be a symbolic link",
    )
    expect(() => installBlueBubblesHostSharedHelper({ assetPath, sharedRoot: fileRoot })).toThrow(
      "shared root must be a directory",
    )
    expect(() => installBlueBubblesHostSharedHelper({ assetPath, sharedRoot: realDirectory }, {
      currentUid: () => 501,
      lstatSync: (filePath) => {
        const stat = lstatSync(filePath)
        return {
          uid: 502,
          mode: stat.mode,
          isSymbolicLink: () => stat.isSymbolicLink(),
          isDirectory: () => stat.isDirectory(),
          isFile: () => stat.isFile(),
        }
      },
    })).toThrow("shared root must be owned by uid 501")
  })

  it("rejects symlinked or wrong-owner shared helper state", () => {
    const f = fixture()
    const helperPath = join(f.sharedRoot, "bluebubbles-host")
    rmSync(helperPath)
    symlinkSync(f.assetPath, helperPath)

    expect(() => installBlueBubblesHostSharedHelper({ assetPath: f.assetPath, sharedRoot: f.sharedRoot })).toThrow(
      "shared helper must not be a symbolic link",
    )
    rmSync(helperPath)
    writeFileSync(helperPath, f.helperBytes, { mode: 0o755 })
    expect(() => installBlueBubblesHostSharedHelper({ assetPath: f.assetPath, sharedRoot: f.sharedRoot }, {
      currentUid: () => 501,
      lstatSync: (filePath) => {
        const stat = lstatSync(filePath)
        return filePath === helperPath
          ? {
              uid: 502,
              mode: stat.mode,
              isSymbolicLink: () => stat.isSymbolicLink(),
              isDirectory: () => stat.isDirectory(),
              isFile: () => stat.isFile(),
            }
          : stat
      },
    })).toThrow("shared helper must be owned by uid 501")
    rmSync(helperPath)
    mkdirSync(helperPath)
    expect(() => installBlueBubblesHostSharedHelper({ assetPath: f.assetPath, sharedRoot: f.sharedRoot })).toThrow(
      "shared helper must be a regular file",
    )
  })

  it("propagates helper replacement failure when no temporary file was created", () => {
    const root = temporaryRoot()
    const assetPath = join(root, "asset")
    const sharedRoot = join(root, "shared")
    writeFileSync(assetPath, "helper")

    expect(() => installBlueBubblesHostSharedHelper({ assetPath, sharedRoot }, {
      writeFileSync: () => { throw new Error("write failed") },
    })).toThrow("write failed")
    expect(existsSync(join(sharedRoot, `bluebubbles-host.${process.pid}.tmp`))).toBe(false)
  })

  it("creates a nonce-bound read-only request and durable private attempt before returning exact handoff commands", () => {
    const f = fixture()

    const handoff = requestCrossUserBlueBubblesHostAction({
      action: "repair",
      username: "clawdbot",
      uid: 502,
      targetHomeDir: f.targetHomeDir,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, f.baseDeps)

    expect(handoff).toEqual({
      classification: "human-required",
      requestId: REQUEST_ID,
      requestPath: join(f.sharedRoot, "bluebubbles-host-requests", `${REQUEST_ID}.json`),
      helperCommand: `${join(f.sharedRoot, "bluebubbles-host")} --request ${join(f.sharedRoot, "bluebubbles-host-requests", `${REQUEST_ID}.json`)}`,
      collectCommand: `ouro bluebubbles host collect --request-id ${REQUEST_ID}`,
    })
    const request = JSON.parse(readFileSync(handoff.requestPath, "utf8")) as BlueBubblesHostRequest
    expect(request).toEqual(requestFixture({ action: "repair" }))
    expect(request.nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(statSync(handoff.requestPath).mode & 0o777).toBe(0o444)
    const attemptPath = blueBubblesHostAttemptPath(f.originHomeDir, REQUEST_ID)
    expect(statSync(attemptPath).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(attemptPath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      status: "pending",
      request,
    })
  })

  it("rejects drifted shared helper trust state before creating a handoff", () => {
    const f = fixture()
    const helperPath = join(f.sharedRoot, "bluebubbles-host")
    const request = () => requestCrossUserBlueBubblesHostAction({
      action: "install",
      username: "clawdbot",
      uid: 502,
      targetHomeDir: f.targetHomeDir,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, f.baseDeps)

    chmodSync(f.sharedRoot, 0o777)
    expect(request).toThrow("shared root mode must be 0755")
    chmodSync(f.sharedRoot, 0o755)
    chmodSync(join(f.sharedRoot, "bluebubbles-host-requests"), 0o777)
    expect(request).toThrow("shared request directory mode must be 0755")
    chmodSync(join(f.sharedRoot, "bluebubbles-host-requests"), 0o755)
    chmodSync(helperPath, 0o777)
    expect(request).toThrow("shared helper mode must be 0755")

    chmodSync(helperPath, 0o755)
    writeFileSync(helperPath, "tampered", { mode: 0o755 })
    expect(request).toThrow("shared helper bytes do not match")
  })

  it("trusts byte-exact packaged helper state through the default asset verifier", () => {
    const root = temporaryRoot()
    const sharedRoot = join(root, "shared")
    const originHomeDir = join(root, "origin")
    const targetHomeDir = join(root, "target")
    const assetPath = join(process.cwd(), "assets", "bluebubbles-host")
    mkdirSync(originHomeDir)
    mkdirSync(targetHomeDir)
    installBlueBubblesHostSharedHelper({ assetPath, sharedRoot })

    expect(requestCrossUserBlueBubblesHostAction({
      action: "status",
      username: "clawdbot",
      uid: 502,
      targetHomeDir,
      originHomeDir,
      sharedRoot,
    }, {
      now: () => NOW,
      randomBytes: () => Buffer.from(NONCE, "hex"),
      lstatSync: (filePath) => {
        const stat = lstatSync(filePath)
        return filePath === targetHomeDir
          ? { uid: 502, mode: stat.mode, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false }
          : stat
      },
    }).requestId).toBe(REQUEST_ID)
  })

  it("uses fixed shared paths when no test root is supplied", () => {
    const memory = virtualProtocolDeps()
    memory.files.set("/asset", Buffer.from("helper"))
    memory.modes.set("/asset", 0o644)
    memory.modes.set("/Users/clawdbot", 0o755)
    memory.owners.set("/Users/clawdbot", 502)

    installBlueBubblesHostSharedHelper({ assetPath: "/asset" }, memory.deps)
    const handoff = requestCrossUserBlueBubblesHostAction({
      action: "install",
      username: "clawdbot",
      uid: 502,
      targetHomeDir: "/Users/clawdbot",
      originHomeDir: "/origin",
    }, memory.deps)
    const receipt = receiptFixture()
    const receiptPath = publishBlueBubblesHostReceipt(receipt, undefined, memory.deps)
    memory.owners.set(receiptPath, 502)
    const collection = collectCrossUserBlueBubblesHostAction({
      requestId: handoff.requestId,
      originHomeDir: "/origin",
    }, memory.deps)

    expect(handoff.requestPath).toBe(`${BLUEBUBBLES_HOST_REQUESTS_DIRECTORY}/${REQUEST_ID}.json`)
    expect(receiptPath).toBe(`${BLUEBUBBLES_HOST_RECEIPTS_DIRECTORY}/${REQUEST_ID}.json`)
    expect(memory.files.get(BLUEBUBBLES_HOST_SHARED_HELPER)?.toString()).toBe("helper")
    expect(collection.status).toBe("collected")
  })

  it("uses uid zero when the runtime does not expose getuid", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid")
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined })
    const memory = virtualProtocolDeps(0)
    const deps = { ...memory.deps }
    delete deps.currentUid
    memory.files.set("/asset", Buffer.from("helper"))
    memory.modes.set("/asset", 0o644)

    try {
      expect(installBlueBubblesHostSharedHelper({ assetPath: "/asset" }, deps).changed).toBe(true)
    } finally {
      if (descriptor) Object.defineProperty(process, "getuid", descriptor)
    }
  })

  it("rejects a nonce source that does not return exactly 32 bytes", () => {
    const f = fixture()

    expect(() => requestCrossUserBlueBubblesHostAction({
      action: "install",
      username: "clawdbot",
      uid: 502,
      targetHomeDir: f.targetHomeDir,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, {
      now: () => NOW,
      randomBytes: () => Buffer.alloc(31),
      existsSync: f.baseDeps.existsSync,
    })).toThrow("nonce source must return 32 bytes")
  })

  it.each([
    ["unsafe username", { username: "../root" }, "invalid BlueBubbles host username"],
    ["system uid", { uid: 499 }, "must be at least 500"],
    ["missing home", { targetHomeDir: "/definitely/missing/ouro-target" }, "target home does not exist"],
  ])("rejects %s before publishing a request", (_label, override, message) => {
    const f = fixture()
    const input = {
      action: "install" as const,
      username: "clawdbot",
      uid: 502,
      targetHomeDir: f.targetHomeDir,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
      ...override,
    }

    expect(() => requestCrossUserBlueBubblesHostAction(input, f.baseDeps)).toThrow(message)
    expect(readdirSync(join(f.sharedRoot, "bluebubbles-host-requests"))).toEqual([])
  })

  it.each([
    ["relative", "relative/home", { uid: 502, mode: 0o755, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false }, "target home must be absolute"],
    ["symlink", "/Users/clawdbot", { uid: 502, mode: 0o755, isSymbolicLink: () => true, isDirectory: () => true, isFile: () => false }, "target home must not be a symbolic link"],
    ["file", "/Users/clawdbot", { uid: 502, mode: 0o755, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }, "target home must be a directory"],
    ["owner", "/Users/clawdbot", { uid: 501, mode: 0o755, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false }, "target home must be owned by uid 502"],
  ])("rejects %s target home trust", (_label, targetHomeDir, targetStat, message) => {
    const f = fixture()
    expect(() => requestCrossUserBlueBubblesHostAction({
      action: "install",
      username: "clawdbot",
      uid: 502,
      targetHomeDir,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, {
      ...f.baseDeps,
      existsSync: (filePath) => filePath === targetHomeDir || existsSync(filePath),
      lstatSync: (filePath) => filePath === targetHomeDir ? targetStat : lstatSync(filePath),
    })).toThrow(message)
  })

  it("validates the target actor, request shape, exact GUI domain, and freshness", () => {
    expect(validateBlueBubblesHostHelperRequest({
      request: requestFixture(),
      currentUsername: "clawdbot",
      currentUid: 502,
      launchdDomainAvailable: true,
      nowMs: NOW + 1_000,
    })).toEqual({ launchdDomain: "gui/502", request: requestFixture() })
  })

  it.each([
    ["schema", requestFixture({ schemaVersion: 2 as 1 }), {}, "unsupported request schema"],
    ["helper", requestFixture({ helperVersion: 2 as 1 }), {}, "unsupported helper version"],
    ["nonce", requestFixture({ nonce: "ABC" }), {}, "invalid request nonce"],
    ["request id", requestFixture({ requestId: "502-wrong" }), {}, "request id does not match"],
    ["action", requestFixture({ action: "explode" as "install" }), {}, "unsupported host action"],
    ["username", requestFixture(), { currentUsername: "someone-else" }, "target username mismatch"],
    ["uid", requestFixture(), { currentUid: 501 }, "target uid mismatch"],
    ["system uid", requestFixture({ uid: 499 }), { currentUid: 499 }, "must be at least 500"],
    ["session", requestFixture(), { launchdDomainAvailable: false }, "logged-in gui/502 session is unavailable"],
    ["future", requestFixture({ requestedAt: new Date(NOW + 2_000).toISOString() }), {}, "request timestamp is in the future"],
    ["wide expiry", requestFixture({ expiresAt: new Date(NOW + EXPECTED_FRESHNESS_MS + 1).toISOString() }), {}, "request freshness window exceeds"],
    ["expired", requestFixture(), { nowMs: NOW + EXPECTED_FRESHNESS_MS + 1 }, "request expired"],
    ["invalid time", requestFixture({ requestedAt: "not-a-date" }), {}, "request timestamp is invalid"],
  ])("rejects invalid helper %s evidence", (_label, request, contextOverride, message) => {
    expect(() => validateBlueBubblesHostHelperRequest({
      request,
      currentUsername: "clawdbot",
      currentUid: 502,
      launchdDomainAvailable: true,
      nowMs: NOW + 1_000,
      ...contextOverride,
    })).toThrow(message)
  })

  it("publishes a read-only receipt with exclusive no-clobber semantics", () => {
    const f = fixture()
    const receipt = receiptFixture()

    const receiptPath = publishBlueBubblesHostReceipt(receipt, { sharedRoot: f.sharedRoot }, {
      now: () => NOW + 1_000,
      randomBytes: (size) => Buffer.alloc(size, 0xcd),
    })

    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual(receipt)
    expect(statSync(receiptPath).mode & 0o777).toBe(0o444)
    expect(() => publishBlueBubblesHostReceipt(receipt, { sharedRoot: f.sharedRoot }, {
      now: () => NOW + 1_000,
      randomBytes: (size) => Buffer.alloc(size, 0xef),
    })).toThrow("receipt already exists")
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual(receipt)
  })

  it("rejects an invalid receipt id before filesystem publication", () => {
    expect(() => publishBlueBubblesHostReceipt(receiptFixture({ requestId: "../../escape" }))).toThrow(
      "invalid BlueBubbles host receipt request id",
    )
  })

  it("propagates unexpected publication failures and cleans the temporary file", () => {
    const f = fixture()
    const receipt = receiptFixture()
    const temporaryPath = join(f.sharedRoot, "bluebubbles-host-receipts", `${REQUEST_ID}.json.${NONCE}.tmp`)

    expect(() => publishBlueBubblesHostReceipt(receipt, { sharedRoot: f.sharedRoot }, {
      linkSync: (existingPath) => {
        rmSync(existingPath)
        throw "link transport failed"
      },
    })).toThrow("link transport failed")
    expect(existsSync(temporaryPath)).toBe(false)
  })

  it("collects only an ownership-bound exact receipt and stores idempotent point-in-time evidence", () => {
    const f = fixture()
    requestCrossUserBlueBubblesHostAction({
      action: "install",
      username: "clawdbot",
      uid: 502,
      targetHomeDir: f.targetHomeDir,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, f.baseDeps)
    const receipt = receiptFixture()
    const deps = writeTargetOwnedReceipt(f.sharedRoot, receipt)

    const first = collectCrossUserBlueBubblesHostAction({
      requestId: REQUEST_ID,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, deps)
    const second = collectCrossUserBlueBubblesHostAction({
      requestId: REQUEST_ID,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, { now: () => NOW + EXPECTED_FRESHNESS_MS + 50_000 })

    expect(first).toEqual({
      requestId: REQUEST_ID,
      status: "collected",
      detail: "launchd verified at 2026-08-17T17:00:01.000Z; current service state requires a fresh helper run",
      receipt,
    })
    expect(second).toEqual(first)
    expect(statSync(blueBubblesHostAttemptPath(f.originHomeDir, REQUEST_ID)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(blueBubblesHostAttemptPath(f.originHomeDir, REQUEST_ID), "utf8"))).toMatchObject({
      status: "collected",
      collection: first,
    })
  })

  it("collects a failed helper receipt with truthful point-in-time wording", () => {
    const f = fixture()
    requestCrossUserBlueBubblesHostAction({
      action: "install",
      username: "clawdbot",
      uid: 502,
      targetHomeDir: f.targetHomeDir,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, f.baseDeps)
    const receipt = receiptFixture({ result: "failed", detail: "service unavailable" })
    const deps = writeTargetOwnedReceipt(f.sharedRoot, receipt)

    const first = collectCrossUserBlueBubblesHostAction({
      requestId: REQUEST_ID,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, deps)
    expect(first.detail).toBe(
      "launchd helper reported failure at 2026-08-17T17:00:01.000Z; current service state requires a fresh helper run",
    )
    expect(collectCrossUserBlueBubblesHostAction({
      requestId: REQUEST_ID,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    })).toEqual(first)
  })

  it("binds a canonical nonstandard target home in the private attempt", () => {
    const f = fixture()
    const customHome = join(f.root, "custom-home")
    mkdirSync(customHome)
    requestCrossUserBlueBubblesHostAction({
      action: "install",
      username: "clawdbot",
      uid: 502,
      targetHomeDir: customHome,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, {
      ...f.baseDeps,
      existsSync,
      lstatSync: (filePath) => filePath === customHome
        ? { uid: 502, mode: 0o755, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false }
        : lstatSync(filePath),
    })
    const receipt = receiptFixture({
      plistPath: join(customHome, "Library", "LaunchAgents", "com.bluebubbles.server.plist"),
    })
    const deps = writeTargetOwnedReceipt(f.sharedRoot, receipt)

    expect(collectCrossUserBlueBubblesHostAction({
      requestId: REQUEST_ID,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, deps).receipt.plistPath).toBe(receipt.plistPath)
    expect(JSON.parse(readFileSync(blueBubblesHostAttemptPath(f.originHomeDir, REQUEST_ID), "utf8"))).toMatchObject({
      targetHomeDir: customHome,
    })
  })

  it.each([
    ["missing", undefined, 502, "receipt is missing"],
    ["wrong owner", receiptFixture(), 501, "receipt owner uid 501 does not match target uid 502"],
    ["mismatched nonce", receiptFixture({ nonce: "cd".repeat(32) }), 502, "receipt nonce does not match request"],
    ["mismatched path", receiptFixture({ appPath: "/tmp/fake.app" }), 502, "receipt app path does not match"],
    ["mismatched plist", receiptFixture({ plistPath: "/tmp/fake.plist" }), 502, "receipt plist path does not match"],
    ["mismatched label", receiptFixture({ launchAgentLabel: "other" as "com.bluebubbles.server" }), 502, "receipt launch agent label does not match"],
    ["mismatched domain", receiptFixture({ launchdDomain: "gui/501" }), 502, "receipt launchd domain does not match"],
    ["stale verification", receiptFixture({ verifiedAt: new Date(NOW + EXPECTED_FRESHNESS_MS + 1).toISOString() }), 502, "receipt verification is outside request freshness"],
    ["invalid result", receiptFixture({ result: "unknown" as "verified" }), 502, "receipt result is invalid"],
    ["empty detail", receiptFixture({ detail: "" }), 502, "receipt detail is invalid"],
  ])("rejects %s receipt evidence without collecting the attempt", (_label, receipt, ownerUid, message) => {
    const f = fixture()
    requestCrossUserBlueBubblesHostAction({
      action: "install",
      username: "clawdbot",
      uid: 502,
      targetHomeDir: f.targetHomeDir,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, f.baseDeps)
    const deps = receipt ? writeTargetOwnedReceipt(f.sharedRoot, receipt, ownerUid) : { now: () => NOW + 1_000 }

    expect(() => collectCrossUserBlueBubblesHostAction({
      requestId: REQUEST_ID,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, deps)).toThrow(message)
    expect(JSON.parse(readFileSync(blueBubblesHostAttemptPath(f.originHomeDir, REQUEST_ID), "utf8"))).toMatchObject({
      status: "pending",
    })
  })

  it("rejects request publication collisions without overwriting prior evidence", () => {
    const f = fixture()
    const collisionPath = join(f.sharedRoot, "bluebubbles-host-requests", `${REQUEST_ID}.json`)
    writeFileSync(collisionPath, "existing", { mode: 0o444 })

    expect(() => requestCrossUserBlueBubblesHostAction({
      action: "install",
      username: "clawdbot",
      uid: 502,
      targetHomeDir: f.targetHomeDir,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, f.baseDeps)).toThrow("request already exists")
    expect(readFileSync(collisionPath, "utf8")).toBe("existing")
  })

  it.each([
    ["invalid id", "invalid", undefined, "invalid BlueBubbles host request id"],
    ["missing attempt", REQUEST_ID, undefined, "BlueBubbles host attempt is missing"],
  ])("rejects collection with %s", (_label, requestId, setup, message) => {
    const f = fixture()
    setup?.()
    expect(() => collectCrossUserBlueBubblesHostAction({
      requestId,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    })).toThrow(message)
  })

  it.each([
    ["invalid attempt state", { schemaVersion: 2, status: "pending", request: requestFixture() }, "attempt state is invalid"],
    ["mismatched request", { schemaVersion: 1, status: "pending", request: requestFixture({ requestId: `503-${NONCE}`, uid: 503 }) }, "attempt request id does not match"],
  ])("rejects %s", (_label, attempt, message) => {
    const f = fixture()
    const attemptPath = blueBubblesHostAttemptPath(f.originHomeDir, REQUEST_ID)
    mkdirSync(join(f.originHomeDir, ".ouro-cli", "bluebubbles-host", "attempts"), { recursive: true })
    writeFileSync(attemptPath, JSON.stringify(attempt), { mode: 0o600 })

    expect(() => collectCrossUserBlueBubblesHostAction({
      requestId: REQUEST_ID,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    })).toThrow(message)
  })

  it("rejects symbolic-link receipt evidence", () => {
    const f = fixture()
    requestCrossUserBlueBubblesHostAction({
      action: "install",
      username: "clawdbot",
      uid: 502,
      targetHomeDir: f.targetHomeDir,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, f.baseDeps)
    const receipt = receiptFixture()
    publishBlueBubblesHostReceipt(receipt, { sharedRoot: f.sharedRoot })

    expect(() => collectCrossUserBlueBubblesHostAction({
      requestId: REQUEST_ID,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, {
      lstatSync: (filePath) => {
        const stat = lstatSync(filePath)
        const isReceipt = filePath.endsWith(`${REQUEST_ID}.json`)
        return {
          uid: isReceipt ? 502 : stat.uid,
          mode: stat.mode,
          isSymbolicLink: () => isReceipt,
          isDirectory: () => stat.isDirectory(),
          isFile: () => stat.isFile(),
        }
      },
    })).toThrow("receipt must not be a symbolic link")
  })

  it.each([
    ["non-file", 0o444, false, "receipt must be a regular file"],
    ["writable", 0o644, true, "receipt mode must be 0444"],
  ])("rejects %s receipt trust state", (_label, mode, isFile, message) => {
    const f = fixture()
    requestCrossUserBlueBubblesHostAction({
      action: "install",
      username: "clawdbot",
      uid: 502,
      targetHomeDir: f.targetHomeDir,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, f.baseDeps)
    const receipt = receiptFixture()
    publishBlueBubblesHostReceipt(receipt, { sharedRoot: f.sharedRoot })

    expect(() => collectCrossUserBlueBubblesHostAction({
      requestId: REQUEST_ID,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, {
      lstatSync: (filePath) => {
        const stat = lstatSync(filePath)
        return filePath.endsWith(`${REQUEST_ID}.json`)
          ? { uid: 502, mode, isSymbolicLink: () => false, isDirectory: () => !isFile, isFile: () => isFile }
          : stat
      },
    })).toThrow(message)
  })

  it.each([
    ["Error", () => { throw new Error("disk read failed") }, "disk read failed"],
    ["non-Error", () => { throw "disk read failed" }, "disk read failed"],
  ])("normalizes %s attempt read failures", (_label, read, message) => {
    const f = fixture()
    const attemptPath = blueBubblesHostAttemptPath(f.originHomeDir, REQUEST_ID)
    mkdirSync(join(f.originHomeDir, ".ouro-cli", "bluebubbles-host", "attempts"), { recursive: true })
    writeFileSync(attemptPath, "present")

    expect(() => collectCrossUserBlueBubblesHostAction({
      requestId: REQUEST_ID,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, { readFileSync: read })).toThrow(`BlueBubbles host attempt is invalid: ${message}`)
  })

  it("cleans an atomic collection temporary file when replacement fails", () => {
    const f = fixture()
    requestCrossUserBlueBubblesHostAction({
      action: "install",
      username: "clawdbot",
      uid: 502,
      targetHomeDir: f.targetHomeDir,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, f.baseDeps)
    const receipt = receiptFixture()
    const targetDeps = writeTargetOwnedReceipt(f.sharedRoot, receipt)
    const attemptPath = blueBubblesHostAttemptPath(f.originHomeDir, REQUEST_ID)
    const temporaryPath = `${attemptPath}.${process.pid}.tmp`

    expect(() => collectCrossUserBlueBubblesHostAction({
      requestId: REQUEST_ID,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, { ...targetDeps, renameSync: () => { throw new Error("rename failed") } })).toThrow("rename failed")
    expect(existsSync(temporaryPath)).toBe(false)
    expect(JSON.parse(readFileSync(attemptPath, "utf8"))).toMatchObject({ status: "pending" })
  })

  it.each([
    ["schema", { schemaVersion: 2 }, "attempt state is invalid"],
    ["request id", { collection: { requestId: `503-${NONCE}` } }, "stored collection request id does not match"],
    ["receipt", { collection: { receipt: { nonce: "cd".repeat(32) } } }, "receipt nonce does not match"],
  ])("rejects malformed stored repeat collection %s", (_label, mutation, message) => {
    const f = fixture()
    requestCrossUserBlueBubblesHostAction({
      action: "install",
      username: "clawdbot",
      uid: 502,
      targetHomeDir: f.targetHomeDir,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, f.baseDeps)
    const receipt = receiptFixture()
    const deps = writeTargetOwnedReceipt(f.sharedRoot, receipt)
    collectCrossUserBlueBubblesHostAction({
      requestId: REQUEST_ID,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, deps)
    const attemptPath = blueBubblesHostAttemptPath(f.originHomeDir, REQUEST_ID)
    const stored = JSON.parse(readFileSync(attemptPath, "utf8"))
    const next = {
      ...stored,
      ...mutation,
      ...(mutation.collection ? {
        collection: {
          ...stored.collection,
          ...mutation.collection,
          ...(mutation.collection.receipt ? {
            receipt: { ...stored.collection.receipt, ...mutation.collection.receipt },
          } : {}),
        },
      } : {}),
    }
    writeFileSync(attemptPath, JSON.stringify(next), { mode: 0o600 })

    expect(() => collectCrossUserBlueBubblesHostAction({
      requestId: REQUEST_ID,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    })).toThrow(message)
  })

  it.each([
    ["target home", { targetHomeDir: "relative/home" }, "attempt target home is invalid"],
    ["status", { status: "unknown", targetHomeDir: "/Users/clawdbot" }, "attempt state is invalid"],
  ])("rejects invalid pending attempt %s", (_label, mutation, message) => {
    const f = fixture()
    const attemptPath = blueBubblesHostAttemptPath(f.originHomeDir, REQUEST_ID)
    mkdirSync(join(f.originHomeDir, ".ouro-cli", "bluebubbles-host", "attempts"), { recursive: true })
    writeFileSync(attemptPath, JSON.stringify({
      schemaVersion: 1,
      status: "pending",
      request: requestFixture(),
      targetHomeDir: "/Users/clawdbot",
      ...mutation,
    }), { mode: 0o600 })

    expect(() => collectCrossUserBlueBubblesHostAction({
      requestId: REQUEST_ID,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    })).toThrow(message)
  })

  it("rejects a stored collection detail that does not match its receipt", () => {
    const f = fixture()
    requestCrossUserBlueBubblesHostAction({
      action: "install",
      username: "clawdbot",
      uid: 502,
      targetHomeDir: f.targetHomeDir,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, f.baseDeps)
    const receipt = receiptFixture()
    const deps = writeTargetOwnedReceipt(f.sharedRoot, receipt)
    collectCrossUserBlueBubblesHostAction({
      requestId: REQUEST_ID,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    }, deps)
    const attemptPath = blueBubblesHostAttemptPath(f.originHomeDir, REQUEST_ID)
    const stored = JSON.parse(readFileSync(attemptPath, "utf8"))
    stored.collection.detail = "tampered"
    writeFileSync(attemptPath, JSON.stringify(stored), { mode: 0o600 })

    expect(() => collectCrossUserBlueBubblesHostAction({
      requestId: REQUEST_ID,
      originHomeDir: f.originHomeDir,
      sharedRoot: f.sharedRoot,
    })).toThrow("stored collection detail does not match receipt")
  })

  it("ships a credential-free helper that checks the effective actor and GUI launchd domain", () => {
    const helper = readFileSync(join(process.cwd(), "assets", "bluebubbles-host"), "utf8")

    expect(helper).toMatch(/^#!\/usr\/bin\/env node/)
    expect(helper).toContain("process.getuid()")
    expect(helper).toContain("id")
    expect(helper).toContain("launchctl")
    expect(helper).toContain("gui/")
    expect(helper).toContain("com.bluebubbles.server")
    expect(helper).not.toMatch(/password|vault|AgentBundles|slugger/i)
    expect(existsSync(join(process.cwd(), "assets", "bluebubbles-host"))).toBe(true)
  })

})
