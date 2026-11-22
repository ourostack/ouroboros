import * as fs from "node:fs"
import { emitNervesEvent } from "../nerves/runtime"
import { queryRsvpSnapshot, summarizeRsvpSnapshot, type RsvpQueryStatus } from "../rsvp/query"
import { parseRsvpSnapshot, type RsvpSnapshot } from "../rsvp/snapshot"
import { withCode, type ToolDefinition } from "./tools-base"

type SnapshotReadResult =
  | { ok: true; snapshot: RsvpSnapshot }
  | { ok: false; message: string; reason: "missing" | "invalid" }

function readSnapshot(snapshotPath: string | undefined): SnapshotReadResult {
  if (!snapshotPath || snapshotPath.trim().length === 0) {
    return { ok: false, reason: "missing", message: withCode("RSVP snapshot not found.", "snapshot-not-found") }
  }
  try {
    const raw = fs.readFileSync(snapshotPath, "utf-8")
    const parsed = parseRsvpSnapshot(JSON.parse(raw) as unknown)
    if (!parsed.ok) {
      return { ok: false, reason: "invalid", message: withCode("RSVP snapshot could not be read or failed integrity validation.", "snapshot-invalid") }
    }
    return { ok: true, snapshot: parsed.snapshot }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { ok: false, reason: "missing", message: withCode("RSVP snapshot not found.", "snapshot-not-found") }
    }
    return { ok: false, reason: "invalid", message: withCode("RSVP snapshot could not be read or failed integrity validation.", "snapshot-invalid") }
  }
}

function emitToolRead(toolName: string, result: SnapshotReadResult): void {
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.rsvp_tool_read",
    message: "RSVP tool read snapshot",
    meta: result.ok
      ? { toolName, snapshotId: result.snapshot.snapshotId, total: result.snapshot.summary.total }
      : { toolName, reason: result.reason },
  })
}

export const rsvpToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "rsvp_query",
        description:
          "answer deterministic questions about a native RSVP snapshot file, such as who is pending, declined, attending, unknown, or matching a guest name.",
        parameters: {
          type: "object",
          properties: {
            snapshot_path: {
              type: "string",
              description: "absolute path to a native RSVP snapshot JSON file.",
            },
            query: {
              type: "string",
              description: "natural-language query or guest-name filter.",
            },
            status: {
              type: "string",
              enum: ["attending", "declined", "pending", "unknown", "all"],
              description: "optional explicit RSVP status filter.",
            },
          },
          required: ["snapshot_path"],
        },
      },
    },
    handler: async (args) => {
      const result = readSnapshot(args.snapshot_path)
      emitToolRead("rsvp_query", result)
      if (!result.ok) return result.message
      return queryRsvpSnapshot(result.snapshot, {
        query: args.query,
        status: args.status as RsvpQueryStatus | undefined,
      }).text
    },
    summaryKeys: ["snapshot_path", "query", "status"],
    riskProfile: { mutates: "none", risk: "low", reason: "reads a local native RSVP snapshot" },
    ax: { id: "tool:rsvp_query", group: "turn-rsvp", when: "Pick this to list which guests are pending, declined or coming, or to look one guest up; rsvp_summary gives only totals.", effect: "read", idempotent: true, errors: [
      { code: "snapshot-not-found", means: "snapshot_path is empty or no file is there.", fix: "Pass the absolute path of the agent's native RSVP snapshot JSON, then query again." },
      { code: "snapshot-invalid", means: "The file can't be read, isn't JSON, or fails the snapshot's integrity check, so no answer is given from it.", fix: "Don't answer from this file; tell the person, and suggest ouro rsvp doctor to check the snapshots." },
    ] },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "rsvp_summary",
        description: "summarize counts and provenance for a native RSVP snapshot file.",
        parameters: {
          type: "object",
          properties: {
            snapshot_path: {
              type: "string",
              description: "absolute path to a native RSVP snapshot JSON file.",
            },
          },
          required: ["snapshot_path"],
        },
      },
    },
    handler: async (args) => {
      const result = readSnapshot(args.snapshot_path)
      emitToolRead("rsvp_summary", result)
      if (!result.ok) return result.message
      return summarizeRsvpSnapshot(result.snapshot)
    },
    summaryKeys: ["snapshot_path"],
    riskProfile: { mutates: "none", risk: "low", reason: "reads a local native RSVP snapshot" },
    ax: { id: "tool:rsvp_summary", group: "turn-rsvp", when: "Pick this for headcounts by reply and when the guest list was fetched, before reporting numbers; rsvp_query names guests.", effect: "read", idempotent: true, errors: [
      { code: "snapshot-not-found", means: "snapshot_path is empty or no file is there.", fix: "Pass the absolute path of the agent's native RSVP snapshot JSON, then summarize again." },
      { code: "snapshot-invalid", means: "The file can't be read, isn't JSON, or fails the snapshot's integrity check, so its counts can't be trusted.", fix: "Don't report counts from this file; tell the person, and suggest ouro rsvp doctor to check the snapshots." },
    ] },
  },
]
