import type { ShepherdSession } from "./surface"
import { emitNervesEvent } from "../../nerves/runtime"

/** A composer locator is enforced at execution, not merely suggested to the model. */
export function assertBoundShepherdTarget(bound: ShepherdSession | undefined, session: string, host?: string): void {
  if (!bound) return
  if (session !== bound.id || (host !== undefined && host !== bound.host)) {
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_target_refused", message: "refused a terminal operation outside the fixed composer target", meta: { host: bound.host, session: bound.id } })
    throw new Error(`this composer is bound to ${bound.host} UUID ${bound.id}; short refs and other targets are refused`)
  }
}
