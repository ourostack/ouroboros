import * as path from "path"
import { getAgentName, getAgentRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { readJsonFile } from "../arc/json-store"
import {
  advanceObligation,
  advanceReturnObligation,
  fulfillObligation,
  readReturnObligation,
  type Obligation,
} from "../arc/obligations"
import type { ToolDefinition } from "./tools-base"

/**
 * `let_go` lets the agent release a held work item from its attention loop.
 *
 * Two stores need release semantics:
 *   1. ReturnObligations at `arc/obligations/inner/<id>.json` (status: queued|running|returned|deferred)
 *      — these are what surface in the "held work items" section of the prompt.
 *   2. Outer Obligations at `arc/obligations/<id>.json` (status: pending|...|fulfilled)
 *      — these surface as "i owe <friend>: ..." in the commitments section.
 *
 * The pre-existing path to terminal state for both is the `surface` tool, which fulfills
 * an obligation as a side-effect of delivering a response. When work is resolved EXTERNALLY
 * (e.g. a PR merged fixed the underlying issue), there is no response to surface — the
 * agent has no way to clear the item, so it cycles in the prompt every turn.
 *
 * `let_go` is the missing primitive: dismissal WITHOUT delivery.
 */

function outerObligationsDir(agentRoot: string): string {
  return path.join(agentRoot, "arc", "obligations")
}

function readOuterObligation(agentRoot: string, id: string): Obligation | null {
  return readJsonFile<Obligation>(outerObligationsDir(agentRoot), id) ?? null
}

interface LetGoArgs {
  id: string
  reason?: string
}

function letGo(args: LetGoArgs, agentRoot: string, agentName: string): string {
  if (typeof args.id !== "string" || args.id.trim().length === 0) {
    return JSON.stringify({ error: "id is required" })
  }
  const id = args.id.trim()
  const reason = typeof args.reason === "string" && args.reason.trim().length > 0
    ? args.reason.trim()
    : null

  // 1. ReturnObligation (inner) first — these are what slugger sees in "held work items".
  const ret = readReturnObligation(agentName, id)
  if (ret) {
    if (ret.status === "returned" || ret.status === "deferred") {
      return JSON.stringify({ kind: "return_obligation", id, already: ret.status })
    }
    advanceReturnObligation(agentName, id, {
      status: "returned",
      returnedAt: Date.now(),
      returnTarget: "surface",
    })
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.obligation_let_go",
      message: "agent let go of return obligation",
      meta: { kind: "return_obligation", id, reason: reason ?? null },
    })
    return JSON.stringify({ kind: "return_obligation", let_go: id, reason })
  }

  // 2. Outer Obligation — these surface as "i owe ..." in commitments.
  const outer = readOuterObligation(agentRoot, id)
  if (outer) {
    if (outer.status === "fulfilled") {
      return JSON.stringify({ kind: "obligation", id, already: "fulfilled" })
    }
    fulfillObligation(agentRoot, id)
    if (reason !== null) {
      // Persist the dismissal reason as the obligation's latestNote so future-me
      // can read why this was released (the nerves event also captures it).
      advanceObligation(agentRoot, id, { latestNote: reason })
    }
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.obligation_let_go",
      message: "agent let go of outer obligation",
      meta: { kind: "obligation", id, reason: reason ?? null },
    })
    return JSON.stringify({ kind: "obligation", let_go: id, reason })
  }

  return JSON.stringify({ error: `no obligation found with id "${id}"` })
}

export const obligationToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "let_go",
        description:
          "release a held work item from my attention. for items that have been resolved externally, no longer apply, or are stale and just cycling in my prompt with nothing to act on. takes the id i see in the 'held work items' section (or any obligation id from arc/obligations/). optional reason is recorded for future me. idempotent — calling on an already-released item returns the existing status, not an error.",
        parameters: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "the obligation id — the bracketed id in 'held work items' (e.g. '1775976317954-s5pno43r'), or any obligation file's id from arc/obligations/.",
            },
            reason: {
              type: "string",
              description: "optional one-line reason i'm letting go (e.g. 'resolved externally by PR #701').",
            },
          },
          required: ["id"],
        },
      },
    },
    handler: (args) => {
      const agentRoot = getAgentRoot()
      const agentName = getAgentName()
      return letGo({ id: args.id, reason: args.reason }, agentRoot, agentName)
    },
  },
]
