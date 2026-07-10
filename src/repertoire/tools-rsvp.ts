import * as fs from "node:fs"
import { emitNervesEvent } from "../nerves/runtime"
import { queryRsvpSnapshot, summarizeRsvpSnapshot, type RsvpQueryStatus } from "../rsvp/query"
import { parseRsvpSnapshot, type RsvpSnapshot } from "../rsvp/snapshot"
import type { ToolDefinition } from "./tools-base"

type SnapshotReadResult =
  | { ok: true; snapshot: RsvpSnapshot }
  | { ok: false; message: string; reason: "missing" | "invalid" }

function readSnapshot(snapshotPath: string | undefined): SnapshotReadResult {
  if (!snapshotPath || snapshotPath.trim().length === 0) {
    return { ok: false, reason: "missing", message: "RSVP snapshot not found." }
  }
  try {
    const raw = fs.readFileSync(snapshotPath, "utf-8")
    const parsed = parseRsvpSnapshot(JSON.parse(raw) as unknown)
    if (!parsed.ok) {
      return { ok: false, reason: "invalid", message: "RSVP snapshot could not be read or failed integrity validation." }
    }
    return { ok: true, snapshot: parsed.snapshot }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { ok: false, reason: "missing", message: "RSVP snapshot not found." }
    }
    return { ok: false, reason: "invalid", message: "RSVP snapshot could not be read or failed integrity validation." }
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
  },
]
