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
  const targetHomeDir = join(root, "target")
  const assetPath = join(root, "bluebubbles-host-asset")
  const helperBytes = "#!/usr/bin/env node\n// generic helper\n"
  const baseDeps = {
    now: () => NOW,
    randomBytes: (size: number) => {
      expect(size).toBe(32)
      return Buffer.from(NONCE, "hex")
    },
  }
  writeFileSync(assetPath, helperBytes, { mode: 0o644 })
  for (const directory of [originHomeDir, targetHomeDir]) {
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
      return filePath.endsWith(`${receipt.requestId}.json`) ? { ...actual, uid } : actual
    },
  }
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

  it.each([
    ["missing", undefined, 502, "receipt is missing"],
    ["wrong owner", receiptFixture(), 501, "receipt owner uid 501 does not match target uid 502"],
    ["mismatched nonce", receiptFixture({ nonce: "cd".repeat(32) }), 502, "receipt nonce does not match request"],
    ["mismatched path", receiptFixture({ appPath: "/tmp/fake.app" }), 502, "receipt app path does not match"],
    ["mismatched label", receiptFixture({ launchAgentLabel: "other" as "com.bluebubbles.server" }), 502, "receipt launch agent label does not match"],
    ["mismatched domain", receiptFixture({ launchdDomain: "gui/501" }), 502, "receipt launchd domain does not match"],
    ["stale verification", receiptFixture({ verifiedAt: new Date(NOW + EXPECTED_FRESHNESS_MS + 1).toISOString() }), 502, "receipt verification is outside request freshness"],
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
