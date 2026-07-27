/**
 * Dead-pipe regression coverage for `ouro doctor`.
 *
 * Every check here exists because a green tick once sat next to a dead pipe:
 * mail ingestion stopped on 2026-05-10 after a vault key rotation and was not
 * noticed for 77 days, while `mail enabled`, `mail config` and a cumulative
 * `45479 messages` count all reported ✔. BlueBubbles inbound delivery died for
 * days while the upstream HTTP probe stayed green.
 *
 * These use real temp-directory fixtures with real mtimes, because directory
 * and file mtimes are the liveness signal under test.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

const mockRuntimeConfigs = vi.hoisted(() => new Map<string, any>())
const mockMachineRuntimeConfigs = vi.hoisted(() => new Map<string, any>())
vi.mock("../../../heart/runtime-credentials", () => ({
  refreshRuntimeCredentialConfig: vi.fn(async (agentName: string) => mockRuntimeConfigs.get(agentName) ?? {
    ok: false,
    reason: "missing",
    itemPath: `vault:${agentName}:runtime/config`,
    error: `no runtime credentials stored at vault:${agentName}:runtime/config`,
  }),
  refreshMachineRuntimeCredentialConfig: vi.fn(async (agentName: string, machineId: string) => mockMachineRuntimeConfigs.get(agentName) ?? {
    ok: false,
    reason: "missing",
    itemPath: `vault:${agentName}:runtime/machines/${machineId}/config`,
    error: `no machine runtime credentials stored at vault:${agentName}:runtime/machines/${machineId}/config`,
  }),
}))

vi.mock("../../../heart/machine-identity", () => ({
  loadOrCreateMachineIdentity: vi.fn(() => ({ machineId: "machine_test" })),
}))

import type { DoctorCheck, DoctorDeps } from "../../../heart/daemon/doctor-types"
import {
  DEFAULT_MAIL_INGEST_THRESHOLDS,
  DEFAULT_SENSE_DELIVERY_THRESHOLDS,
  checkMailroom,
  checkSenses,
  runDoctorChecks,
  senseInboundDeliveryCheck,
} from "../../../heart/daemon/doctor"

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const tempRoots: string[] = []

function makeBundlesRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-doctor-liveness-"))
  tempRoots.push(root)
  return root
}

function setMtime(target: string, whenMs: number): void {
  const when = new Date(whenMs)
  fs.utimesSync(target, when, when)
}

function writeAgent(root: string, agent = "slugger", senses?: Record<string, unknown>): string {
  const agentRoot = path.join(root, `${agent}.ouro`)
  fs.mkdirSync(agentRoot, { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({
    version: 2,
    enabled: true,
    humanFacing: { provider: "anthropic", model: "claude" },
    agentFacing: { provider: "anthropic", model: "claude" },
    ...(senses ? { senses } : {}),
  }), "utf-8")
  return agentRoot
}

interface MailroomFixture {
  /** How long ago the newest message file was written. */
  lastIngestAgoMs?: number | null
  /** How many message files the store holds. */
  messageCount?: number
  /** How long ago the mailbox was provisioned. */
  provisionedAgoMs?: number
  /** Absolute epoch-ms override for the messages/ directory mtime. */
  messagesMtimeMs?: number
  /** Absolute epoch-ms override for the registry.json mtime. */
  registryMtimeMs?: number
}

function writeMailroom(agentRoot: string, fixture: MailroomFixture = {}): string {
  const mailroomRoot = path.join(agentRoot, "state", "mailroom")
  const messagesDir = path.join(mailroomRoot, "messages")
  fs.mkdirSync(messagesDir, { recursive: true })

  const registryPath = path.join(mailroomRoot, "registry.json")
  fs.writeFileSync(registryPath, JSON.stringify({
    schemaVersion: 1,
    domain: "ouro.bot",
    mailboxes: [{
      agentId: "slugger",
      mailboxId: "mailbox_slugger",
      canonicalAddress: "slugger@ouro.bot",
      keyId: "mail_slugger-native_c8c0f198d5fc068e",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----\n",
      defaultPlacement: "screener",
    }],
    sourceGrants: [{
      grantId: "grant_slugger_hey_31a41026",
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      aliasAddress: "me.mendelow.ari.slugger@ouro.bot",
      keyId: "mail_slugger-hey_4c628d031cbe560c",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----\n",
      defaultPlacement: "imbox",
      enabled: true,
    }],
  }), "utf-8")

  const messageCount = fixture.messageCount ?? 3
  for (let index = 0; index < messageCount; index += 1) {
    fs.writeFileSync(path.join(messagesDir, `mail_${index}.json`), JSON.stringify({
      schemaVersion: 1,
      id: `mail_${index}`,
      // `receivedAt` is when the mail was sent, not when it was ingested. An
      // mbox backfill writes month-old values today, which is exactly why the
      // liveness signal is the store's write time, not this field.
      receivedAt: "2026-04-14T20:41:57.000Z",
    }), "utf-8")
  }

  if (typeof fixture.messagesMtimeMs === "number") {
    setMtime(messagesDir, fixture.messagesMtimeMs)
  } else if (typeof fixture.lastIngestAgoMs === "number") {
    setMtime(messagesDir, Date.now() - fixture.lastIngestAgoMs)
  }

  setMtime(registryPath, fixture.registryMtimeMs ?? Date.now() - (fixture.provisionedAgoMs ?? 200 * DAY_MS))
  return mailroomRoot
}

function depsFor(bundlesRoot: string, overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    existsSync: fs.existsSync,
    readFileSync: (p) => fs.readFileSync(p, "utf-8"),
    readdirSync: (p) => fs.readdirSync(p),
    statSync: (p) => fs.statSync(p),
    checkSocketAlive: vi.fn(async () => true),
    socketPath: "/tmp/ouro.sock",
    bundlesRoot,
    homedir: path.dirname(bundlesRoot),
    envPath: "/usr/bin",
    platform: "darwin",
    ...overrides,
  }
}

interface HostedMirrorFixture {
  /** How long ago this machine last cached a hosted message it had not seen. */
  lastObservedAgoMs?: number
  /** How many search-cache documents the local mirror holds. */
  documentCount?: number
  /** Absolute epoch-ms override for the mail-search/ directory mtime. */
  mirrorMtimeMs?: number
}

/**
 * The hosted reader's local search cache — `state/mail-search/<messageId>.json`
 * — which `mailroom/reader.ts` hands to `AzureBlobMailroomStore`. This is the
 * only local artifact that still moves once an agent is on the hosted store.
 */
function writeHostedMirror(agentRoot: string, fixture: HostedMirrorFixture = {}): string {
  const mirrorDir = path.join(agentRoot, "state", "mail-search")
  fs.mkdirSync(mirrorDir, { recursive: true })
  const documentCount = fixture.documentCount ?? 3
  for (let index = 0; index < documentCount; index += 1) {
    fs.writeFileSync(
      path.join(mirrorDir, `mail_${index}.json`),
      JSON.stringify({ schemaVersion: 1, messageId: `mail_${index}`, agentId: "slugger" }),
      "utf-8",
    )
  }
  if (typeof fixture.mirrorMtimeMs === "number") {
    setMtime(mirrorDir, fixture.mirrorMtimeMs)
  } else if (typeof fixture.lastObservedAgoMs === "number") {
    setMtime(mirrorDir, Date.now() - fixture.lastObservedAgoMs)
  }
  return mirrorDir
}

const HOSTED_ACCOUNT_URL = "https://ouroprodpe5nvwd7rt3r4.blob.core.windows.net"
const HOSTED_STORE_LABEL = `hosted azure-blob ${HOSTED_ACCOUNT_URL}/mailroom`

function seedMailRuntime(agent: string, mailroom: Record<string, unknown>, mode = "hosted"): void {
  mockRuntimeConfigs.set(agent, {
    ok: true,
    itemPath: `vault:${agent}:runtime/config`,
    revision: "runtime_test",
    updatedAt: "2026-07-27T00:00:00.000Z",
    config: {
      workSubstrate: { mode },
      mailroom: {
        mailboxAddress: `${agent}@ouro.bot`,
        privateKeys: { mail_slugger_native: "-----BEGIN PRIVATE KEY-----stub-----END PRIVATE KEY-----" },
        ...mailroom,
      },
    },
  })
}

function seedHostedMailRuntime(agent = "slugger", mailroom: Record<string, unknown> = { azureContainer: "mailroom" }): void {
  seedMailRuntime(agent, { azureAccountUrl: HOSTED_ACCOUNT_URL, ...mailroom })
}

function findCheck(checks: DoctorCheck[], id: string): DoctorCheck {
  const found = checks.find((check) => check.id === id)
  if (!found) throw new Error(`no check with id ${id} in: ${checks.map((c) => c.label).join(", ")}`)
  return found
}

function seedBlueBubblesRuntime(agent = "slugger"): void {
  mockMachineRuntimeConfigs.set(agent, {
    ok: true,
    itemPath: `vault:${agent}:runtime/machines/machine_test/config`,
    revision: "runtime_machine_test",
    updatedAt: "2026-07-26T00:00:00.000Z",
    config: {
      bluebubbles: { serverUrl: "http://bluebubbles.local", password: "pw" },
    },
  })
}

afterEach(() => {
  mockRuntimeConfigs.clear()
  mockMachineRuntimeConfigs.clear()
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ── Mail ingest liveness ──

describe("checkMailroom mail-ingest liveness", () => {
  it("passes when mail was ingested recently", async () => {
    const bundlesRoot = makeBundlesRoot()
    writeMailroom(writeAgent(bundlesRoot), { lastIngestAgoMs: 20 * 60 * 1000 })

    const check = findCheck((await checkMailroom(depsFor(bundlesRoot))).checks, "mail.ingest_liveness")

    expect(check.status).toBe("pass")
    expect(check.label).toBe("slugger.ouro mail ingest liveness")
    expect(check.detail).toContain("mail ingested 20 minutes ago")
    expect(check.detail).not.toContain("fix:")
  })

  it("warns once ingestion has been quiet past the warn threshold", async () => {
    const bundlesRoot = makeBundlesRoot()
    writeMailroom(writeAgent(bundlesRoot), { lastIngestAgoMs: 30 * HOUR_MS })

    const check = findCheck((await checkMailroom(depsFor(bundlesRoot))).checks, "mail.ingest_liveness")

    expect(check.status).toBe("warn")
    expect(check.detail).toContain("no mail ingested in 30 hours")
    expect(check.detail).toContain("fix: mail is configured but nothing is arriving")
  })

  it("separates 'mailbox configured' from 'mail pipe alive' in the reported checks", async () => {
    const bundlesRoot = makeBundlesRoot()
    writeMailroom(writeAgent(bundlesRoot), { lastIngestAgoMs: 10 * DAY_MS })

    const checks = (await checkMailroom(depsFor(bundlesRoot))).checks
    const configured = checks.find((check) => check.label === "slugger.ouro mailroom")!
    const alive = findCheck(checks, "mail.ingest_liveness")

    expect(configured.status).toBe("pass")
    expect(configured.detail).toContain("1 mailbox, 1 source grant, 3 messages stored")
    expect(configured.detail).toContain("cumulative — not a liveness signal")
    expect(alive.status).toBe("fail")
    expect(alive.detail).toContain("mailbox configured; no mail ingested in 10 days")
  })

  it("REGRESSION 2026-05-10: fails doctor when the newest mail is 77 days old", async () => {
    // The real incident, replayed against a frozen clock. Slugger's mailroom
    // last ingested at 2026-05-10T23:24Z; by 2026-07-27 that was 77 days of
    // silence, and `ouro doctor` still reported:
    //   ✔ slugger.ouro mail          enabled
    //   ✔ slugger.ouro mail config   slugger@ouro.bot; local file Mailroom; ...
    //   ✔ slugger.ouro mailroom      1 mailbox, 1 source grant, 45479 messages
    // The cumulative message count only ever goes up, so it could not signal
    // the outage. This asserts doctor now FAILS instead of passing.
    const bundlesRoot = makeBundlesRoot()
    writeMailroom(writeAgent(bundlesRoot), {
      messageCount: 45,
      messagesMtimeMs: Date.parse("2026-05-10T23:24:00.000Z"),
      registryMtimeMs: Date.parse("2026-01-08T00:00:00.000Z"),
    })

    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"))
    try {
      const result = await runDoctorChecks(depsFor(bundlesRoot), { category: "Mailroom" })
      const checks = result.categories[0].checks
      const configured = checks.find((check) => check.label === "slugger.ouro mailroom")!
      const alive = findCheck(checks, "mail.ingest_liveness")

      // The configuration check still passes — that is precisely why it could
      // not catch this. The liveness check is what makes the outage visible.
      expect(configured.status).toBe("pass")
      expect(alive.status).toBe("fail")
      expect(alive.detail).toContain("no mail ingested in 77 days")
      expect(alive.detail).toContain("last message 2026-05-10T23:24Z")
      expect(alive.detail).toContain("a server-side key rotation silently orphans ingestion")
      // The whole point: the aggregate doctor result is no longer clean.
      expect(result.summary.failed).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("fails when a provisioned mailbox has never ingested anything", async () => {
    const bundlesRoot = makeBundlesRoot()
    writeMailroom(writeAgent(bundlesRoot), { messageCount: 0, provisionedAgoMs: 30 * DAY_MS })

    const check = findCheck((await checkMailroom(depsFor(bundlesRoot))).checks, "mail.ingest_liveness")

    expect(check.status).toBe("fail")
    expect(check.detail).toContain("no mail ingested ever — the store is readable and empty")
    expect(check.detail).toContain("has been configured for 30 days")
  })

  it("warns rather than fails for a mailbox provisioned moments ago with no mail yet", async () => {
    const bundlesRoot = makeBundlesRoot()
    writeMailroom(writeAgent(bundlesRoot), { messageCount: 0, provisionedAgoMs: 5 * 60 * 1000 })

    const check = findCheck((await checkMailroom(depsFor(bundlesRoot))).checks, "mail.ingest_liveness")

    expect(check.status).toBe("warn")
    expect(check.detail).toContain("has been configured for 5 minutes")
  })

  it("reports 'never' when the messages directory is missing entirely", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    const mailroomRoot = writeMailroom(agentRoot, { messageCount: 0 })
    fs.rmSync(path.join(mailroomRoot, "messages"), { recursive: true, force: true })

    const check = findCheck((await checkMailroom(depsFor(bundlesRoot))).checks, "mail.ingest_liveness")

    expect(check.status).toBe("fail")
    expect(check.detail).toContain("no mail ingested ever")
    expect(check.detail).toContain("does not exist")
  })

  it("fails as unverified — not healthy — when the message store cannot be listed", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    const messagesDir = path.join(writeMailroom(agentRoot, { lastIngestAgoMs: HOUR_MS }), "messages")
    const deps = depsFor(bundlesRoot, {
      readdirSync: (p) => {
        if (p === messagesDir) throw new Error("EACCES: permission denied")
        return fs.readdirSync(p)
      },
    })

    const check = findCheck((await checkMailroom(deps)).checks, "mail.ingest_liveness")

    expect(check.status).toBe("fail")
    expect(check.detail).toContain("mail ingested: last-activity time could not be determined")
    expect(check.detail).toContain("unverified, not healthy")
  })

  it("warns instead of silently passing when the store mtime is in the future", async () => {
    const bundlesRoot = makeBundlesRoot()
    writeMailroom(writeAgent(bundlesRoot), { messagesMtimeMs: Date.now() + 2 * DAY_MS })

    const check = findCheck((await checkMailroom(depsFor(bundlesRoot))).checks, "mail.ingest_liveness")

    expect(check.status).toBe("warn")
    expect(check.detail).toContain("in the future")
    expect(check.detail).toContain("clock skew means freshness cannot be trusted")
  })

  it("honours a per-agent threshold override from agent.json", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot, "slugger", {
      mail: { enabled: true, freshness: { warnAfterHours: 1, failAfterHours: 2 } },
    })
    writeMailroom(agentRoot, { lastIngestAgoMs: 3 * HOUR_MS })

    const check = findCheck((await checkMailroom(depsFor(bundlesRoot))).checks, "mail.ingest_liveness")

    expect(check.status).toBe("fail")
    expect(check.detail).toContain("no mail ingested in 3 hours")
  })

  it("falls back to defaults when agent.json is missing or unparseable", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    writeMailroom(agentRoot, { lastIngestAgoMs: 30 * HOUR_MS })
    fs.writeFileSync(path.join(agentRoot, "agent.json"), "{not json", "utf-8")

    expect(findCheck((await checkMailroom(depsFor(bundlesRoot))).checks, "mail.ingest_liveness").status).toBe("warn")

    fs.rmSync(path.join(agentRoot, "agent.json"))
    expect(findCheck((await checkMailroom(depsFor(bundlesRoot))).checks, "mail.ingest_liveness").status).toBe("warn")
  })

  it("uses 24h/72h defaults, so a quiet weekend warns before it fails", () => {
    expect(DEFAULT_MAIL_INGEST_THRESHOLDS).toEqual({ warnAfterMs: 24 * HOUR_MS, failAfterMs: 72 * HOUR_MS })
  })

  it("keeps reading the local store when the runtime config says the reader is on local files", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    writeMailroom(agentRoot, { lastIngestAgoMs: 30 * HOUR_MS })
    // A fresh mirror must not rescue a local-mode agent: with no
    // `azureAccountUrl` the reader writes messages/, so messages/ is the truth.
    writeHostedMirror(agentRoot, { lastObservedAgoMs: 5 * 60 * 1000 })
    seedMailRuntime("slugger", { storePath: path.join(agentRoot, "state", "mailroom") }, "local")

    const check = findCheck((await checkMailroom(depsFor(bundlesRoot))).checks, "mail.ingest_liveness")

    expect(check.status).toBe("warn")
    expect(check.detail).toContain("no mail ingested in 30 hours")
    expect(check.detail).toContain("state/mailroom/messages")
  })
})

// ── Hosted (Azure Blob) Mailroom ──
//
// Cutting an agent over to the hosted store freezes `state/mailroom/messages`
// at the cutover date, because nothing writes there any more. Measuring it in
// hosted mode reports a dead pipe that is demonstrably alive — a false failure,
// which teaches operators to ignore the check and so destroys the thing #885
// was built for. These pin the mode-aware signal.

describe("checkMailroom mail-ingest liveness on the hosted Mailroom", () => {
  it("passes on the local hosted mirror, and names the hosted store it cannot read", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    writeMailroom(agentRoot, { lastIngestAgoMs: 77 * DAY_MS })
    writeHostedMirror(agentRoot, { lastObservedAgoMs: 20 * 60 * 1000 })
    seedHostedMailRuntime()

    const check = findCheck((await checkMailroom(depsFor(bundlesRoot))).checks, "mail.ingest_liveness")

    expect(check.status).toBe("pass")
    expect(check.label).toBe("slugger.ouro mail ingest liveness")
    expect(check.detail).toContain("hosted mail observed locally 20 minutes ago")
    expect(check.detail).toContain(HOSTED_STORE_LABEL)
    expect(check.detail).toContain("state/mail-search")
    expect(check.detail).toContain("which doctor does not read")
    expect(check.detail).not.toContain("fix:")
  })

  it("REGRESSION 2026-07-27: does not report a 77-day outage from the frozen local store after the hosted cutover", async () => {
    // The real false failure, replayed against a frozen clock. Slugger moved to
    // the hosted Mailroom, so `state/mailroom/messages` stopped changing on
    // 2026-05-10 — while `mail_recent` showed messages dated today and the blob
    // container held 5000+ blobs with today's Last-Modified. `ouro doctor` said:
    //   ✔ slugger.ouro mail config           slugger@ouro.bot; hosted azure-blob …
    //   ✘ slugger.ouro mail ingest liveness  no mail ingested in 77 days …
    //                                        derived from …/state/mailroom/messages
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    writeMailroom(agentRoot, {
      messageCount: 45,
      messagesMtimeMs: Date.parse("2026-05-10T23:24:00.000Z"),
      registryMtimeMs: Date.parse("2026-01-08T00:00:00.000Z"),
    })
    writeHostedMirror(agentRoot, { documentCount: 45, mirrorMtimeMs: Date.parse("2026-07-27T07:49:00.000Z") })
    seedHostedMailRuntime()

    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-27T08:00:00.000Z"))
    try {
      const result = await runDoctorChecks(depsFor(bundlesRoot), { category: "Mailroom" })
      const alive = findCheck(result.categories[0].checks, "mail.ingest_liveness")

      expect(alive.detail).not.toContain("no mail ingested in 77 days")
      expect(alive.detail).not.toContain("state/mailroom/messages")
      expect(alive.status).toBe("pass")
      expect(alive.detail).toContain("hosted mail observed locally 11 minutes ago")
      expect(result.summary.failed).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("warns, then fails, as the hosted mirror goes quiet", async () => {
    const warnRoot = makeBundlesRoot()
    const warnAgentRoot = writeAgent(warnRoot)
    writeMailroom(warnAgentRoot, { lastIngestAgoMs: HOUR_MS })
    writeHostedMirror(warnAgentRoot, { lastObservedAgoMs: 30 * HOUR_MS })
    seedHostedMailRuntime()

    const warned = findCheck((await checkMailroom(depsFor(warnRoot))).checks, "mail.ingest_liveness")

    expect(warned.status).toBe("warn")
    expect(warned.detail).toContain("no hosted mail observed locally in 30 hours")
    expect(warned.detail).toContain("fix: doctor measures hosted mail only through this machine's local mirror")

    const failRoot = makeBundlesRoot()
    const failAgentRoot = writeAgent(failRoot)
    writeMailroom(failAgentRoot, { lastIngestAgoMs: HOUR_MS })
    writeHostedMirror(failAgentRoot, { lastObservedAgoMs: 9 * DAY_MS })

    const failed = findCheck((await checkMailroom(depsFor(failRoot))).checks, "mail.ingest_liveness")

    expect(failed.status).toBe("fail")
    expect(failed.detail).toContain("no hosted mail observed locally in 9 days")
    expect(failed.detail).toContain(`listing \`messages/\` blobs in ${HOSTED_STORE_LABEL} by Last-Modified`)
  })

  it("reports the unverified 'unknown' state — not pass, not a fake outage — when no hosted mirror exists", async () => {
    const bundlesRoot = makeBundlesRoot()
    writeMailroom(writeAgent(bundlesRoot), { lastIngestAgoMs: 77 * DAY_MS })
    seedHostedMailRuntime()

    const check = findCheck((await checkMailroom(depsFor(bundlesRoot))).checks, "mail.ingest_liveness")

    expect(check.status).toBe("fail")
    expect(check.detail).toContain("last-activity time could not be determined")
    expect(check.detail).toContain("is absent")
    expect(check.detail).toContain("not read by doctor (no network calls, no credentials)")
    expect(check.detail).toContain("unverified, not healthy")
    // Neither of the two wrong answers: a confident pass, or the local store's
    // frozen mtime dressed up as a hosted outage.
    expect(check.detail).not.toContain("no mail ingested")
    expect(check.detail).not.toContain("77 days")
  })

  it("treats an empty hosted mirror as unverified rather than 'the hosted store never delivered'", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    writeMailroom(agentRoot, { lastIngestAgoMs: 77 * DAY_MS })
    writeHostedMirror(agentRoot, { documentCount: 0 })
    seedHostedMailRuntime()

    const check = findCheck((await checkMailroom(depsFor(bundlesRoot))).checks, "mail.ingest_liveness")

    expect(check.status).toBe("fail")
    expect(check.detail).toContain("is empty")
    expect(check.detail).toContain("unverified, not healthy")
    expect(check.detail).not.toContain("the store is readable and empty")
  })

  it("reports unverified when the hosted mirror exists but cannot be listed", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    writeMailroom(agentRoot, { lastIngestAgoMs: HOUR_MS })
    const mirrorDir = writeHostedMirror(agentRoot, { lastObservedAgoMs: HOUR_MS })
    seedHostedMailRuntime()
    const deps = depsFor(bundlesRoot, {
      readdirSync: (p) => {
        if (p === mirrorDir) throw new Error("EACCES: permission denied")
        return fs.readdirSync(p)
      },
    })

    const check = findCheck((await checkMailroom(deps)).checks, "mail.ingest_liveness")

    expect(check.status).toBe("fail")
    expect(check.detail).toContain("exists but could not be listed")
    expect(check.detail).toContain("unverified, not healthy")
  })

  it("defaults the container name to `mailroom` when the runtime config omits it", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot)
    writeMailroom(agentRoot, { lastIngestAgoMs: 77 * DAY_MS })
    writeHostedMirror(agentRoot, { lastObservedAgoMs: HOUR_MS })
    seedHostedMailRuntime("slugger", {})

    const check = findCheck((await checkMailroom(depsFor(bundlesRoot))).checks, "mail.ingest_liveness")

    expect(check.status).toBe("pass")
    expect(check.detail).toContain(HOSTED_STORE_LABEL)
  })

  it("honours the same per-agent threshold override in hosted mode", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot, "slugger", {
      mail: { enabled: true, freshness: { warnAfterHours: 1, failAfterHours: 2 } },
    })
    writeMailroom(agentRoot, { lastIngestAgoMs: HOUR_MS })
    writeHostedMirror(agentRoot, { lastObservedAgoMs: 3 * HOUR_MS })
    seedHostedMailRuntime()

    const check = findCheck((await checkMailroom(depsFor(bundlesRoot))).checks, "mail.ingest_liveness")

    expect(check.status).toBe("fail")
    expect(check.detail).toContain("no hosted mail observed locally in 3 hours")
  })
})

// ── Sense inbound-delivery liveness ──

describe("checkSenses bluebubbles inbound-delivery liveness", () => {
  function writeInbound(agentRoot: string, files: Record<string, number>): string {
    const inboundDir = path.join(agentRoot, "state", "senses", "bluebubbles", "inbound")
    fs.mkdirSync(inboundDir, { recursive: true })
    for (const [name, ageMs] of Object.entries(files)) {
      const filePath = path.join(inboundDir, name)
      fs.writeFileSync(filePath, `${JSON.stringify({ recordedAt: new Date(Date.now() - ageMs).toISOString() })}\n`, "utf-8")
      setMtime(filePath, Date.now() - ageMs)
    }
    return inboundDir
  }

  it("passes when inbound messages are still arriving", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot, "slugger", { bluebubbles: { enabled: true } })
    writeInbound(agentRoot, { "chat_a.ndjson": 10 * DAY_MS, "chat_b.ndjson": 30 * 60 * 1000 })
    seedBlueBubblesRuntime()

    const category = await checkSenses(depsFor(bundlesRoot))
    const check = findCheck(category.checks, "senses.bluebubbles.inbound_liveness")

    expect(check.status).toBe("pass")
    expect(check.label).toBe("slugger.ouro bluebubbles inbound delivery")
    expect(check.detail).toContain("bluebubbles inbound delivery 30 minutes ago")
  })

  it("REGRESSION: fails on dead inbound delivery even while the upstream probe is green", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot, "slugger", { bluebubbles: { enabled: true } })
    writeInbound(agentRoot, { "chat_a.ndjson": 9 * DAY_MS })
    seedBlueBubblesRuntime()
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }))

    const category = await checkSenses(depsFor(bundlesRoot, { fetchImpl: fetchImpl as unknown as typeof fetch }))
    const upstream = category.checks.find((check) => check.label === "slugger.ouro bluebubbles upstream")!
    const inbound = findCheck(category.checks, "senses.bluebubbles.inbound_liveness")

    expect(upstream.status).toBe("pass")
    expect(inbound.status).toBe("fail")
    expect(inbound.detail).toContain("upstream probe reachable — which does not prove inbound delivery")
    expect(inbound.detail).toContain("no bluebubbles inbound delivery in 9 days")
    expect(inbound.detail).toContain("stale webhook port")
  })

  it("notes when the upstream probe did not run in this pass", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot, "slugger", { bluebubbles: { enabled: true } })
    writeInbound(agentRoot, { "chat_a.ndjson": 5 * DAY_MS })
    seedBlueBubblesRuntime()

    const category = await checkSenses(depsFor(bundlesRoot))
    const check = findCheck(category.checks, "senses.bluebubbles.inbound_liveness")

    expect(check.status).toBe("warn")
    expect(check.detail).toContain("upstream probe not run in this pass")
  })

  it("reports the failing upstream probe as context when the upstream is also down", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot, "slugger", { bluebubbles: { enabled: true } })
    writeInbound(agentRoot, { "chat_a.ndjson": 9 * DAY_MS })
    seedBlueBubblesRuntime()
    const fetchImpl = vi.fn().mockRejectedValue(new Error("fetch failed"))

    const category = await checkSenses(depsFor(bundlesRoot, { fetchImpl: fetchImpl as unknown as typeof fetch }))
    const check = findCheck(category.checks, "senses.bluebubbles.inbound_liveness")

    expect(check.status).toBe("fail")
    expect(check.detail).toContain("upstream probe failing")
  })

  it("flags a sense that has been attached for a while but never delivered anything", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot, "slugger", { bluebubbles: { enabled: true } })
    const inboundDir = writeInbound(agentRoot, {})
    setMtime(path.dirname(inboundDir), Date.now() - 30 * DAY_MS)
    seedBlueBubblesRuntime()

    const category = await checkSenses(depsFor(bundlesRoot))
    const check = findCheck(category.checks, "senses.bluebubbles.inbound_liveness")

    expect(check.status).toBe("fail")
    expect(check.detail).toContain("no bluebubbles inbound delivery ever")
    expect(check.detail).toContain("has been configured for 30 days")
  })

  it("honours a per-sense threshold override from agent.json", async () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot, "slugger", {
      bluebubbles: { enabled: true, freshness: { warnAfterHours: 1, failAfterHours: 2 } },
    })
    writeInbound(agentRoot, { "chat_a.ndjson": 3 * HOUR_MS })
    seedBlueBubblesRuntime()

    const category = await checkSenses(depsFor(bundlesRoot))
    const check = findCheck(category.checks, "senses.bluebubbles.inbound_liveness")

    expect(check.status).toBe("fail")
  })

  it("uses 72h/7d defaults, so bursty human chat traffic does not cry wolf", () => {
    expect(DEFAULT_SENSE_DELIVERY_THRESHOLDS).toEqual({ warnAfterMs: 72 * HOUR_MS, failAfterMs: 7 * DAY_MS })
  })
})

// ── Reusable seam for other senses ──

describe("senseInboundDeliveryCheck", () => {
  it("lets another sense opt in with its own inbound directory and remediation", () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot, "slugger", { teams: { enabled: true } })
    const inboundDir = path.join(agentRoot, "state", "senses", "teams", "inbound")
    fs.mkdirSync(inboundDir, { recursive: true })
    const logPath = path.join(inboundDir, "conversation.jsonl")
    fs.writeFileSync(logPath, "{}\n", "utf-8")
    setMtime(logPath, Date.now() - 8 * DAY_MS)

    const check = senseInboundDeliveryCheck({
      deps: depsFor(bundlesRoot),
      agentDir: "slugger.ouro",
      sense: "teams",
      inboundDir,
      logSuffix: ".jsonl",
      remediation: "re-register the Teams subscription",
      nowMs: Date.now(),
    })

    expect(check.id).toBe("senses.teams.inbound_liveness")
    expect(check.label).toBe("slugger.ouro teams inbound delivery")
    expect(check.status).toBe("fail")
    expect(check.detail).toContain("no teams inbound delivery in 8 days")
    expect(check.detail).toContain("fix: re-register the Teams subscription")
  })

  it("treats an unknown attach time as no excuse for a silent pipe", () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot, "slugger", { teams: { enabled: true } })
    const inboundDir = path.join(agentRoot, "state", "senses", "teams", "inbound")
    fs.mkdirSync(inboundDir, { recursive: true })

    const check = senseInboundDeliveryCheck({
      deps: depsFor(bundlesRoot),
      agentDir: "slugger.ouro",
      sense: "teams",
      inboundDir,
      remediation: "re-register the Teams subscription",
      nowMs: Date.now(),
    })

    expect(check.status).toBe("fail")
    expect(check.detail).toContain("no teams inbound delivery ever")
    expect(check.detail).not.toContain("has been configured for")
  })

  it("reports an unreadable configuredSince path as an unknown attach time", () => {
    const bundlesRoot = makeBundlesRoot()
    const agentRoot = writeAgent(bundlesRoot, "slugger", { teams: { enabled: true } })
    const inboundDir = path.join(agentRoot, "state", "senses", "teams", "inbound")
    fs.mkdirSync(inboundDir, { recursive: true })
    const senseRoot = path.dirname(inboundDir)

    const check = senseInboundDeliveryCheck({
      deps: depsFor(bundlesRoot, {
        statSync: (p) => {
          if (p === senseRoot) throw new Error("EACCES")
          return fs.statSync(p)
        },
      }),
      agentDir: "slugger.ouro",
      sense: "teams",
      inboundDir,
      configuredSincePath: senseRoot,
      remediation: "re-register the Teams subscription",
      nowMs: Date.now(),
    })

    expect(check.status).toBe("fail")
    expect(check.detail).not.toContain("has been configured for")
  })
})
