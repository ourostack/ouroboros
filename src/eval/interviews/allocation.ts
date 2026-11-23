/**
 * The pre-registered allocation (Appendix B): every session's model, job and labelled arms in run order, read from
 * the pre-registration file itself and refused unless its rows hash to the SHA-256 a registered version states in its
 * Appendix A, so a session can never run from an edited table. Each version is a separate file with its own seed, and
 * results from different versions are never pooled.
 */
import crypto from "node:crypto"
import { emitNervesEvent } from "../../nerves/runtime"
import { ARMS, LABELS, type Product } from "./protocol"

/** Each registered version's SHA-256 of Appendix B's rows as its allocation script prints them, one per line. */
export const REGISTERED_ALLOCATIONS: Readonly<Record<string, number>> = {
  // preregistration.md, registered 2026-11-22, seed 20261122.
  ca0b441641c6c62e70238ee2b31b2283d358103d683061a97e0174f6c29851f2: 1,
  // preregistration-v2.md, registered 2026-11-23, seed 20261123: the study on Copilot, with no MiniMax.
  "71fc28b44d71b1b3d09dffebafa377059a514b42c4a1524cbd3cf7182531c379": 2,
}

export type LabelledArm = { label: string; arm: string }
export type Session = { id: string; product: Product; model: string; job: string; arms: [LabelledArm, LabelledArm, LabelledArm]; pilot: boolean }
export type Allocation = { version: number; sessions: Session[] }

/**
 * The id a session is marked started under. Version 1's ids are kept as they were written; a later version's are
 * prefixed with it, since every version reuses ids such as `X-pilot` and each of its sessions starts once, ever.
 */
export function startedKey(version: number, id: string): string {
  return version === 1 ? id : `v${version}/${id}`
}

const ROW = /^\| ([HUX])-(\S+) \| (\S+) \| (\S+) \| (.+) \|$/

function parseArms(product: Product, cell: string, id: string): Session["arms"] {
  const arms = cell.split(", ").map((pair) => {
    const [label, arm] = pair.split("=")
    if (!label || !arm || !(LABELS as readonly string[]).includes(label) || !ARMS[product].includes(arm)) throw new Error(`session ${id}: ${pair} is not a label and one of ${product}'s arms`)
    return { label, arm }
  })
  if (arms.length !== 3 || new Set(arms.map((a) => a.arm)).size !== 3 || new Set(arms.map((a) => a.label)).size !== 3) throw new Error(`session ${id} must have three different labels and arms`)
  return arms as Session["arms"]
}

/** Every session of Appendix B in its order, and the registered version whose table it is, from the pre-registration's text. */
export function readAllocation(preregistration: string, registered: Readonly<Record<string, number>> = REGISTERED_ALLOCATIONS): Allocation {
  const start = preregistration.indexOf("## Appendix B")
  const end = preregistration.indexOf("## Appendix C")
  if (start < 0 || end < start) throw new Error("the pre-registration has no Appendix B")
  const rows = preregistration.slice(start, end).split("\n").filter((line) => /^\| [HUX]-/.test(line))
  const sha = crypto.createHash("sha256").update(`${rows.join("\n")}\n`).digest("hex")
  const version = registered[sha]
  if (version === undefined) {
    const known = Object.entries(registered).map(([hash, v]) => `version ${v}: ${hash}`).join(", ")
    throw new Error(`Appendix B hashes to ${sha}, not the table of any registered version (${known}); refusing to run from a changed allocation`)
  }
  const sessions = rows.map((line): Session => {
    const match = ROW.exec(line)
    if (!match) throw new Error(`Appendix B row is malformed: ${line}`)
    const product = match[1] as Product
    const id = `${product}-${match[2]}`
    return { id, product, model: match[3]!, job: match[4]!, arms: parseArms(product, match[5]!, id), pilot: match[2] === "pilot" }
  })
  emitNervesEvent({ component: "eval", event: "eval.interview_allocation_read", message: "read the pre-registered allocation", meta: { sessions: sessions.length, version } })
  return { version, sessions }
}

/**
 * The reduced design (section 5): per model and product, only the sessions whose order is a rotation of the arm list
 * (`ouro, alt1, alt2`, `alt1, alt2, ouro`, `alt2, ouro, alt1`). Pilot sessions are kept as they are.
 */
export function reducedDesign(sessions: Session[]): Session[] {
  return sessions.filter((session) => {
    if (session.pilot) return true
    const [a, b, c] = ARMS[session.product]
    const order = session.arms.map((entry) => entry.arm).join(",")
    return [[a, b, c], [b, c, a], [c, a, b]].some((rotation) => rotation.join(",") === order)
  })
}
