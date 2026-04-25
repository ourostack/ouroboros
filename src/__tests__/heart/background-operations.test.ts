import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const cleanup: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
  cleanup.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  while (cleanup.length > 0) {
    const dir = cleanup.pop()
    if (!dir) continue
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("background operations", () => {
  it("persists queued, running, and succeeded operations for later status reads", async () => {
    const {
      startBackgroundOperation,
      markBackgroundOperationRunning,
      completeBackgroundOperation,
      readBackgroundOperation,
      listBackgroundOperations,
    } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-roundtrip")
    const queued = startBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_1",
      kind: "mail.import-mbox",
      title: "mail import",
      summary: "queued Ari's HEY archive import",
      createdAt: "2026-04-23T22:40:00.000Z",
      spec: {
        filePath: "/tmp/ari-hey.mbox",
        ownerEmail: "ari@mendelow.me",
        source: "hey",
      },
    })

    expect(queued.status).toBe("queued")
    expect(queued.spec).toEqual({
      filePath: "/tmp/ari-hey.mbox",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })

    const running = markBackgroundOperationRunning({
      agentName: "slugger",
      agentRoot,
      id: queued.id,
      startedAt: "2026-04-23T22:40:05.000Z",
      summary: "importing Ari's HEY archive",
      detail: "scanned 500 messages",
      progress: {
        current: 500,
        total: 16616,
        unit: "messages",
      },
    })

    expect(running.status).toBe("running")
    expect(running.progress).toEqual({
      current: 500,
      total: 16616,
      unit: "messages",
    })

    const succeeded = completeBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: queued.id,
      finishedAt: "2026-04-23T22:41:00.000Z",
      summary: "imported Ari's HEY archive",
      detail: "scanned 16616 messages; imported 16142; duplicates 474",
      result: {
        scanned: 16616,
        imported: 16142,
        duplicates: 474,
        sourceFreshThrough: "2026-04-22T17:16:00.000Z",
      },
    })

    expect(succeeded.status).toBe("succeeded")
    expect(succeeded.finishedAt).toBe("2026-04-23T22:41:00.000Z")
    expect(readBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: queued.id,
    })).toEqual(succeeded)
    expect(listBackgroundOperations({
      agentName: "slugger",
      agentRoot,
    })).toEqual([succeeded])
  })

  it("returns no background operations when the state directory does not exist yet", async () => {
    const { listBackgroundOperations } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-empty")
    expect(listBackgroundOperations({
      agentName: "slugger",
      agentRoot,
    })).toEqual([])
  })

  it("persists failed operations with remediation hints", async () => {
    const {
      startBackgroundOperation,
      failBackgroundOperation,
      listBackgroundOperations,
    } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-failure")
    startBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_backfill_1",
      kind: "mail.backfill-indexes",
      title: "mail index repair",
      summary: "queued hosted mail index repair",
      createdAt: "2026-04-23T22:45:00.000Z",
    })

    const failed = failBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_backfill_1",
      finishedAt: "2026-04-23T22:46:00.000Z",
      summary: "hosted mail index repair failed",
      detail: "24 blob downloads timed out",
      error: "hosted message index backfill incomplete after indexing 16583 message(s)",
      remediation: [
        "rerun the hosted index repair to retry the residue",
        "inspect the remaining blob ids if repeated timeouts persist",
      ],
    })

    expect(failed.status).toBe("failed")
    expect(failed.error).toEqual({
      message: "hosted message index backfill incomplete after indexing 16583 message(s)",
    })
    expect(failed.remediation).toEqual([
      "rerun the hosted index repair to retry the residue",
      "inspect the remaining blob ids if repeated timeouts persist",
    ])
    expect(listBackgroundOperations({
      agentName: "slugger",
      agentRoot,
    })).toEqual([failed])
  })

  it("persists explicit failure classification metadata and clears it on completion", async () => {
    const {
      startBackgroundOperation,
      failBackgroundOperation,
      completeBackgroundOperation,
      readBackgroundOperation,
    } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-failure-classification")
    startBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_failure_class",
      kind: "mail.import-mbox",
      title: "mail import",
      summary: "queued delegated mail import",
      createdAt: "2026-04-24T18:00:00.000Z",
    })

    const failed = failBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_failure_class",
      finishedAt: "2026-04-24T18:01:00.000Z",
      summary: "delegated mail import failed",
      error: "mailroom config incomplete",
      remediation: ["repair config", "retry import"],
      failure: {
        class: "mailroom-config",
        retryDisposition: "fix-before-retry",
        hint: "mailroom runtime config is incomplete for this agent",
      },
    })

    expect(failed.failure).toEqual({
      class: "mailroom-config",
      retryDisposition: "fix-before-retry",
      hint: "mailroom runtime config is incomplete for this agent",
    })

    const completed = completeBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_failure_class",
      finishedAt: "2026-04-24T18:02:00.000Z",
      summary: "delegated mail import succeeded after repair",
      result: { imported: 12 },
    })

    expect(completed.failure).toBeUndefined()
    expect(completed.error).toBeUndefined()
    expect(completed.remediation).toBeUndefined()
    expect(readBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_failure_class",
    })).toEqual(completed)
  })

  it("drops malformed failure metadata instead of persisting guessed values", async () => {
    const {
      startBackgroundOperation,
      failBackgroundOperation,
    } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-malformed-failure")
    startBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_bad_failure",
      kind: "mail.import-mbox",
      title: "mail import",
      summary: "queued delegated mail import",
      createdAt: "2026-04-24T18:05:00.000Z",
    })

    const failed = failBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_bad_failure",
      finishedAt: "2026-04-24T18:06:00.000Z",
      summary: "delegated mail import failed",
      error: "unknown failure",
      remediation: ["inspect runtime state"],
      failure: {
        class: "   ",
        retryDisposition: "not-a-real-disposition" as never,
        hint: "   ",
      },
    })

    expect(failed.failure).toBeUndefined()
  })

  it("rejects invalid operation records before writing them to disk", async () => {
    const { startBackgroundOperation } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-invalid-record")
    expect(() => startBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_invalid_background_record",
      kind: "" as never,
      title: "mail import",
      summary: "queued delegated mail import",
      createdAt: "2026-04-24T18:08:00.000Z",
    })).toThrow("invalid background operation record: op_invalid_background_record")
  })

  it("persists retry-safe failures without inventing a hint", async () => {
    const {
      startBackgroundOperation,
      failBackgroundOperation,
    } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-retry-safe")
    startBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_retry_safe",
      kind: "mail.import-mbox",
      title: "mail import",
      summary: "queued delegated mail import",
      createdAt: "2026-04-24T18:09:00.000Z",
    })

    const failed = failBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_retry_safe",
      finishedAt: "2026-04-24T18:10:00.000Z",
      summary: "delegated mail import failed",
      error: "socket closed early",
      failure: {
        class: "transient-storage-read",
        retryDisposition: "retry-safe",
        hint: "   ",
      },
    })

    expect(failed.failure).toEqual({
      class: "transient-storage-read",
      retryDisposition: "retry-safe",
    })
  })

  it("normalizes investigate-first failures read from disk", async () => {
    const {
      readBackgroundOperation,
    } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-investigate-first")
    const stateDir = path.join(agentRoot, "state", "background-operations")
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(path.join(stateDir, "op_mail_import_investigate_first.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: "op_mail_import_investigate_first",
      agentName: "slugger",
      kind: "mail.import-mbox",
      title: "mail import",
      status: "failed",
      summary: "delegated mail import failed",
      createdAt: "2026-04-24T18:11:00.000Z",
      updatedAt: "2026-04-24T18:12:00.000Z",
      finishedAt: "2026-04-24T18:12:00.000Z",
      failure: {
        class: "mailroom-auth",
        retryDisposition: "investigate-first",
        hint: "unlock the owning vault before retrying",
      },
    }, null, 2)}\n`, "utf-8")

    expect(readBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_investigate_first",
    })?.failure).toEqual({
      class: "mailroom-auth",
      retryDisposition: "investigate-first",
      hint: "unlock the owning vault before retrying",
    })
  })

  it("drops invalid retry and hint shapes while preserving a valid failure class", async () => {
    const {
      readBackgroundOperation,
    } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-invalid-failure-shape")
    const stateDir = path.join(agentRoot, "state", "background-operations")
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(path.join(stateDir, "op_mail_import_invalid_failure_shape.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: "op_mail_import_invalid_failure_shape",
      agentName: "slugger",
      kind: "mail.import-mbox",
      title: "mail import",
      status: "failed",
      summary: "delegated mail import failed",
      createdAt: "2026-04-24T18:13:00.000Z",
      updatedAt: "2026-04-24T18:14:00.000Z",
      finishedAt: "2026-04-24T18:14:00.000Z",
      failure: {
        class: "archive-access",
        retryDisposition: "eventually-maybe",
        hint: 42,
      },
    }, null, 2)}\n`, "utf-8")

    expect(readBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_invalid_failure_shape",
    })?.failure).toEqual({
      class: "archive-access",
    })
  })

  it("drops non-string failure classes when normalizing on-disk records", async () => {
    const {
      readBackgroundOperation,
    } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-invalid-failure-class")
    const stateDir = path.join(agentRoot, "state", "background-operations")
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(path.join(stateDir, "op_mail_import_invalid_failure_class.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: "op_mail_import_invalid_failure_class",
      agentName: "slugger",
      kind: "mail.import-mbox",
      title: "mail import",
      status: "failed",
      summary: "delegated mail import failed",
      createdAt: "2026-04-24T18:15:00.000Z",
      updatedAt: "2026-04-24T18:16:00.000Z",
      finishedAt: "2026-04-24T18:16:00.000Z",
      failure: {
        class: 404,
        retryDisposition: "retry-safe",
        hint: "ignored because class is invalid",
      },
    }, null, 2)}\n`, "utf-8")

    expect(readBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_invalid_failure_class",
    })?.failure).toBeUndefined()
  })

  it("updates operations without inventing optional detail or spec fields", async () => {
    const {
      startBackgroundOperation,
      updateBackgroundOperation,
    } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-update-optional-fields")
    startBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_optional_fields",
      kind: "mail.import-mbox",
      title: "mail import",
      summary: "queued delegated mail import",
      createdAt: "2026-04-24T18:17:00.000Z",
    })

    const updated = updateBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_optional_fields",
      summary: "still queued delegated mail import",
    })

    expect(updated.detail).toBeUndefined()
    expect(updated.spec).toBeUndefined()
    expect(updated.summary).toBe("still queued delegated mail import")
  })

  it("updates operation spec when new tracked metadata is supplied", async () => {
    const {
      startBackgroundOperation,
      updateBackgroundOperation,
    } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-update-spec")
    startBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_update_spec",
      kind: "mail.import-mbox",
      title: "mail import",
      summary: "queued delegated mail import",
      createdAt: "2026-04-24T18:18:00.000Z",
    })

    const updated = updateBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_update_spec",
      summary: "reading Mailroom config",
      spec: {
        filePath: "/tmp/ari-hey.mbox",
      },
    })

    expect(updated.spec).toEqual({
      filePath: "/tmp/ari-hey.mbox",
    })
  })

  it("preserves the prior summary when completion and failure omit optional fields", async () => {
    const {
      startBackgroundOperation,
      completeBackgroundOperation,
      failBackgroundOperation,
      readBackgroundOperation,
    } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-optional-fields")
    startBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_optional",
      kind: "mail.import-mbox",
      title: "mail import",
      summary: "queued delegated mail import",
      createdAt: "2026-04-23T22:50:00.000Z",
    })

    const completed = completeBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_optional",
      finishedAt: "2026-04-23T22:51:00.000Z",
    })
    expect(completed.summary).toBe("queued delegated mail import")
    expect(completed.result).toBeUndefined()

    startBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_backfill_optional",
      kind: "mail.backfill-indexes",
      title: "mail index repair",
      summary: "queued hosted mail index repair",
      createdAt: "2026-04-23T22:52:00.000Z",
    })

    const failed = failBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_backfill_optional",
      finishedAt: "2026-04-23T22:53:00.000Z",
      error: "timed out while reading blobs",
      remediation: [],
      progress: {
        current: 24,
        total: 49,
        unit: " blobs ",
      },
    })

    expect(failed.summary).toBe("queued hosted mail index repair")
    expect(failed.progress).toEqual({
      current: 24,
      total: 49,
      unit: "blobs",
    })
    expect(failed.remediation).toBeUndefined()
    expect(readBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_backfill_optional",
    })).toEqual(failed)
  })

  it("updates running and in-flight records without dropping preserved fields", async () => {
    const {
      startBackgroundOperation,
      completeBackgroundOperation,
      markBackgroundOperationRunning,
      updateBackgroundOperation,
    } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-update-flow")
    startBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_update",
      kind: "mail.import-mbox",
      title: "mail import",
      summary: "queued delegated mail import",
      createdAt: "2026-04-23T23:00:00.000Z",
    })

    completeBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_update",
      finishedAt: "2026-04-23T23:05:00.000Z",
      summary: "imported delegated mail archive",
    })

    const rerunning = markBackgroundOperationRunning({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_update",
      startedAt: "2026-04-23T23:06:00.000Z",
    })
    expect(rerunning.finishedAt).toBe("2026-04-23T23:05:00.000Z")

    const updated = updateBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_update",
      summary: "importing delegated mail",
      detail: "reading registry and MBOX",
      progress: {
        current: 50,
        total: 100,
        unit: "messages",
      },
      updatedAt: "2026-04-23T23:06:30.000Z",
    })
    expect(updated.summary).toBe("importing delegated mail")
    expect(updated.detail).toBe("reading registry and MBOX")
    expect(updated.progress).toEqual({
      current: 50,
      total: 100,
      unit: "messages",
    })
    expect(updated.updatedAt).toBe("2026-04-23T23:06:30.000Z")

    const preserved = updateBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_update",
      detail: "still reading registry",
    })
    expect(preserved.summary).toBe("importing delegated mail")
    expect(preserved.updatedAt).toBe("2026-04-23T23:06:30.000Z")
    expect(preserved.detail).toBe("still reading registry")

    const completed = completeBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_update",
      finishedAt: "2026-04-23T23:07:00.000Z",
      progress: {
        current: 100,
        total: 100,
        unit: "messages",
      },
    })
    expect(completed.progress).toEqual({
      current: 100,
      total: 100,
      unit: "messages",
    })
  })

  it("ignores invalid records, sorts newest first, and respects limits", async () => {
    const {
      startBackgroundOperation,
      listBackgroundOperations,
      readBackgroundOperation,
    } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-listing")
    const operationsDir = path.join(agentRoot, "state", "background-operations")
    fs.mkdirSync(operationsDir, { recursive: true })

    const older = startBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_old",
      kind: "mail.import-mbox",
      title: "older import",
      summary: "queued older import",
      createdAt: "2026-04-23T22:30:00.000Z",
    })
    const newer = startBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_new",
      kind: "mail.import-mbox",
      title: "newer import",
      summary: "queued newer import",
      createdAt: "2026-04-23T22:35:00.000Z",
    })

    fs.writeFileSync(path.join(operationsDir, "invalid-status.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: "op_invalid",
      agentName: "slugger",
      kind: "mail.import-mbox",
      title: "broken record",
      status: "stuck",
      summary: "should be ignored",
      createdAt: "2026-04-23T22:20:00.000Z",
      updatedAt: "2026-04-23T22:20:00.000Z",
    }, null, 2)}\n`, "utf-8")

    expect(readBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "invalid-status",
    })).toBeNull()

    expect(listBackgroundOperations({
      agentName: "slugger",
      agentRoot,
    })).toEqual([newer, older])

    expect(listBackgroundOperations({
      agentName: "slugger",
      agentRoot,
      limit: 1,
    })).toEqual([newer])
  })

  it("shows only the newest mail import record for the same archive/source binding", async () => {
    const {
      startBackgroundOperation,
      failBackgroundOperation,
      completeBackgroundOperation,
      listBackgroundOperations,
    } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-mail-import-collapse")
    startBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_old_fail",
      kind: "mail.import-mbox",
      title: "mail import",
      summary: "queued delegated mail import",
      createdAt: "2026-04-23T23:20:00.000Z",
      spec: {
        filePath: "/tmp/HEY-emails-arimendelow@hey.com.mbox",
        ownerEmail: "ari@mendelow.me",
        source: "hey",
      },
    })
    const olderFailed = failBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_old_fail",
      finishedAt: "2026-04-23T23:21:00.000Z",
      summary: "delegated mail import failed",
      detail: "file: /tmp/HEY-emails-arimendelow@hey.com.mbox",
      error: "download messages/mail_old.json timed out after 20000ms",
    })

    startBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_new_success",
      kind: "mail.import-mbox",
      title: "mail import",
      summary: "queued delegated mail import",
      createdAt: "2026-04-23T23:22:00.000Z",
      spec: {
        filePath: "/tmp/HEY-emails-arimendelow@hey.com.mbox",
        ownerEmail: "ari@mendelow.me",
        source: "hey",
      },
    })
    const newerSucceeded = completeBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_new_success",
      finishedAt: "2026-04-23T23:23:00.000Z",
      summary: "imported delegated mail archive",
      detail: "scanned 16616; imported 0; duplicates 16616",
    })

    startBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_primary_ready",
      kind: "mail.import-mbox",
      title: "mail import",
      summary: "queued delegated mail import",
      createdAt: "2026-04-23T23:24:00.000Z",
      spec: {
        filePath: "/tmp/HEY-emails-ari-mendelow-me.mbox",
        ownerEmail: "ari@mendelow.me",
        source: "hey",
      },
    })
    const primaryReady = completeBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_primary_ready",
      finishedAt: "2026-04-23T23:25:00.000Z",
      summary: "imported delegated mail archive",
      detail: "scanned 12; imported 12; duplicates 0",
    })

    expect(listBackgroundOperations({
      agentName: "slugger",
      agentRoot,
    })).toEqual([primaryReady, newerSucceeded])
    expect(olderFailed.status).toBe("failed")
  })

  it("normalizes remediation lists when reading stored records", async () => {
    const { readBackgroundOperation } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-remediation")
    const operationsDir = path.join(agentRoot, "state", "background-operations")
    fs.mkdirSync(operationsDir, { recursive: true })
    fs.writeFileSync(path.join(operationsDir, "op_mail_backfill_manual.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: "op_mail_backfill_manual",
      agentName: "slugger",
      kind: "mail.backfill-indexes",
      title: "mail index repair",
      status: "failed",
      summary: "hosted mail index repair failed",
      createdAt: "2026-04-23T23:10:00.000Z",
      updatedAt: "2026-04-23T23:11:00.000Z",
      remediation: ["retry the command", " ", 17, "inspect the residue list"],
    }, null, 2)}\n`, "utf-8")

    expect(readBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_backfill_manual",
    })?.remediation).toEqual([
      "retry the command",
      "inspect the residue list",
    ])

    fs.writeFileSync(path.join(operationsDir, "op_mail_backfill_blank.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: "op_mail_backfill_blank",
      agentName: "slugger",
      kind: "mail.backfill-indexes",
      title: "mail index repair",
      status: "failed",
      summary: "hosted mail index repair failed",
      createdAt: "2026-04-23T23:12:00.000Z",
      updatedAt: "2026-04-23T23:13:00.000Z",
      remediation: [" ", "", null],
    }, null, 2)}\n`, "utf-8")
    expect(readBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_backfill_blank",
    })?.remediation).toBeUndefined()
  })

  it("drops malformed progress payloads when reading stored records", async () => {
    const { readBackgroundOperation } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-progress")
    const operationsDir = path.join(agentRoot, "state", "background-operations")
    fs.mkdirSync(operationsDir, { recursive: true })
    fs.writeFileSync(path.join(operationsDir, "op_mail_import_progress_invalid.json"), `${JSON.stringify({
      schemaVersion: 1,
      id: "op_mail_import_progress_invalid",
      agentName: "slugger",
      kind: "mail.import-mbox",
      title: "mail import",
      status: "running",
      summary: "importing delegated mail",
      createdAt: "2026-04-23T23:14:00.000Z",
      updatedAt: "2026-04-23T23:15:00.000Z",
      progress: {
        current: "later",
        total: "unknown",
        unit: " ",
      },
    }, null, 2)}\n`, "utf-8")

    expect(readBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "op_mail_import_progress_invalid",
    })?.progress).toBeUndefined()
  })

  it("rejects stored records that are missing required fields", async () => {
    const { readBackgroundOperation } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-required-fields")
    const operationsDir = path.join(agentRoot, "state", "background-operations")
    fs.mkdirSync(operationsDir, { recursive: true })

    const base = {
      schemaVersion: 1,
      id: "op_mail_import_valid",
      agentName: "slugger",
      kind: "mail.import-mbox",
      title: "mail import",
      status: "queued",
      summary: "queued delegated mail import",
      createdAt: "2026-04-23T23:16:00.000Z",
      updatedAt: "2026-04-23T23:16:00.000Z",
    }
    const cases: Array<{ fileId: string; record: Record<string, unknown> }> = [
      { fileId: "invalid-schema", record: { ...base, schemaVersion: 2 } },
      { fileId: "invalid-id", record: { ...base, id: " " } },
      { fileId: "invalid-agent-name", record: { ...base, agentName: " " } },
      { fileId: "invalid-kind", record: { ...base, kind: " " } },
      { fileId: "invalid-title", record: { ...base, title: " " } },
      { fileId: "invalid-summary", record: { ...base, summary: " " } },
      { fileId: "invalid-created-at", record: { ...base, createdAt: " " } },
      { fileId: "invalid-updated-at", record: { ...base, updatedAt: " " } },
    ]

    for (const entry of cases) {
      fs.writeFileSync(
        path.join(operationsDir, `${entry.fileId}.json`),
        `${JSON.stringify(entry.record, null, 2)}\n`,
        "utf-8",
      )
      expect(readBackgroundOperation({
        agentName: "slugger",
        agentRoot,
        id: entry.fileId,
      })).toBeNull()
    }
  })

  it("returns an empty list when the operations directory cannot be read", async () => {
    const { listBackgroundOperations } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-unreadable")
    const operationsDir = path.join(agentRoot, "state", "background-operations")
    fs.mkdirSync(path.dirname(operationsDir), { recursive: true })
    fs.writeFileSync(operationsDir, "not a directory\n", "utf-8")

    expect(listBackgroundOperations({
      agentName: "slugger",
      agentRoot,
    })).toEqual([])
  })

  it("throws when attempting to update a missing background operation", async () => {
    const { updateBackgroundOperation } = await import("../../heart/background-operations")

    const agentRoot = makeTempDir("background-operations-missing")

    expect(() => updateBackgroundOperation({
      agentName: "slugger",
      agentRoot,
      id: "missing-op",
      summary: "should fail",
    })).toThrowError("background operation not found: missing-op")
  })
})
