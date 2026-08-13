export type IngressIdentityProvider = "imessage-handle"

export type IngressTargetAuthorship = "agent" | "non_agent_unknown" | null

export type IngressCanonicalAction = "add" | "remove" | null

export type IngressCanonicalValue =
  | "love"
  | "like"
  | "dislike"
  | "laugh"
  | "emphasize"
  | "question"
  | "custom"
  | "unknown"
  | null

export type BlueBubblesSemanticEventKind =
  | "message"
  | "reaction"
  | "edit"
  | "unsend"
  | "read"
  | "delivery"

export interface ObservedIngressIdentity {
  provider: IngressIdentityProvider
  externalId: string
  displayName: string | null
}

export interface BlueBubblesSemanticCaptureEvent {
  provider: "bluebubbles"
  kind: BlueBubblesSemanticEventKind
  eventGuid: string | null
  fromMe: boolean
  actor: ObservedIngressIdentity
  participants: ObservedIngressIdentity[]
  sourceEventType: string
  sessionKey: string | null
  chatGuid: string | null
  chatIdentifier: string | null
  text: string | null
  textSha256: string | null
  targetGuid: string | null
  targetAuthorship: IngressTargetAuthorship
  canonicalAction: IngressCanonicalAction
  canonicalValue: IngressCanonicalValue
  rawTransportValue: string | null
  effectiveAt: string | null
  revision: string | null
  contentSha256: string | null
}

export interface BlueBubblesSemanticCaptureV1 {
  schemaVersion: 1
  canonicalKey: string
  keyHash: string
  providerNamespace: string
  capturedAt: string
  /** Runtime-only, non-enumerable metadata loaded from the rollback-safe order sidecar. */
  observationObservedAt?: string
  observationEpoch?: string
  observationOrdinal?: number
  event: BlueBubblesSemanticCaptureEvent
}
