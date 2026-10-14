import type { ShepherdSession } from "./surface"

/** A composer locator is enforced at execution, not merely suggested to the model. */
export function assertBoundShepherdTarget(bound: ShepherdSession | undefined, session: string, host?: string): void {
  if (!bound) return
  if (session !== bound.id || (host !== undefined && host !== bound.host)) {
    throw new Error(`this composer is bound to ${bound.host} UUID ${bound.id}; short refs and other targets are refused`)
  }
}
