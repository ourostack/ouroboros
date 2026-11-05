/** Supplied by trusted local administration after resolving the existing local-family owner. Not human-presence proof. */
export interface ShepherdAdministrationContext {
  kind: "local_owner_administration"
  actorId: string
  requestId: string
}

export interface ShepherdMandateTarget {
  project: string
  host?: string
  session?: string
  instance?: string
}

export interface ShepherdMandateProvenance extends ShepherdAdministrationContext {
  at: string
}

export interface ShepherdMandate {
  id: string
  revision: number
  target: ShepherdMandateTarget
  task: string
  action: "continue_text"
  createdAt: string
  expiresAt: string
  status: "active" | "revoked"
  provenance: ShepherdMandateProvenance
  revoked: ShepherdMandateProvenance | null
}

export type ShepherdMandateRequest = {
  context: ShepherdAdministrationContext
  expectedRevision: number
} & (
  | { operation: "grant"; target: ShepherdMandateTarget; task: string; expiresAt: string }
  | { operation: "revoke"; mandateId: string }
)

export interface ShepherdMandateReceipt {
  revision: number
  operation: "grant" | "revoke"
  mandateId: string
  provenance: ShepherdMandateProvenance
}

export interface ShepherdMandateState {
  version: 1
  revision: number
  mandates: ShepherdMandate[]
  requests: Array<{ actorId: string; requestId: string; hash: string; receipt: ShepherdMandateReceipt }>
}

export type ShepherdMandateResolution =
  | { state: "authorized"; mandate: ShepherdMandate }
  | { state: "withheld"; reason: "invalid_mandate_state" | "invalid_project" | "no_applicable_mandate" | "ambiguous_mandates" }
