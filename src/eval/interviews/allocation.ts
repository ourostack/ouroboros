/**
 * The pre-registered allocation (Appendix B): every session's model, job and labelled arms in run order, read from
 * the pre-registration file itself and refused unless its rows hash to the SHA-256 the file states (Appendix A), so a
 * session can never run from an edited table.
 */
import crypto from "node:crypto"
import { emitNervesEvent } from "../../nerves/runtime"
import { ARMS, LABELS, type Product } from "./protocol"

/** The SHA-256 of Appendix B's rows as the allocation script prints them, one per line. */
export const APPENDIX_B_SHA256 = "ca0b441641c6c62e70238ee2b31b2283d358103d683061a97e0174f6c29851f2"

export type LabelledArm = { label: string; arm: string }
export type Session = { id: string; product: Product; model: string; job: string; arms: [LabelledArm, LabelledArm, LabelledArm]; pilot: boolean }

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

/** Every session of Appendix B in its order, from the pre-registration's text. */
export function readAllocation(preregistration: string, expectedSha256 = APPENDIX_B_SHA256): Session[] {
  const start = preregistration.indexOf("## Appendix B")
  const end = preregistration.indexOf("## Appendix C")
  if (start < 0 || end < start) throw new Error("the pre-registration has no Appendix B")
  const rows = preregistration.slice(start, end).split("\n").filter((line) => /^\| [HUX]-/.test(line))
  const sha = crypto.createHash("sha256").update(`${rows.join("\n")}\n`).digest("hex")
  if (sha !== expectedSha256) throw new Error(`Appendix B hashes to ${sha}, not the registered ${expectedSha256}; refusing to run from a changed allocation`)
  const sessions = rows.map((line): Session => {
    const match = ROW.exec(line)
    if (!match) throw new Error(`Appendix B row is malformed: ${line}`)
    const product = match[1] as Product
    const id = `${product}-${match[2]}`
    return { id, product, model: match[3]!, job: match[4]!, arms: parseArms(product, match[5]!, id), pilot: match[2] === "pilot" }
  })
  emitNervesEvent({ component: "eval", event: "eval.interview_allocation_read", message: "read the pre-registered allocation", meta: { sessions: sessions.length } })
  return sessions
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
