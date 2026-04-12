// Context kernel type definitions.
// FriendRecord (merged identity + notes), channel capabilities, and resolved context.

import { emitNervesEvent } from "../../nerves/runtime"

// -- Identity Provider --
// Closed union: "aad" (Azure AD / Teams), "local" (CLI / OS),
// "teams-conversation" (fallback), "imessage-handle" (BlueBubbles/iMessage)
export type IdentityProvider = "aad" | "local" | "teams-conversation" | "imessage-handle"

const IDENTITY_PROVIDERS: ReadonlySet<string> = new Set<IdentityProvider>(["aad", "local", "teams-conversation", "imessage-handle"])

export function isIdentityProvider(value: unknown): value is IdentityProvider {
  emitNervesEvent({
    component: "friends",
    event: "friends.identity_provider_check",
    message: "identity provider validation",
    meta: {},
  })
  return typeof value === "string" && IDENTITY_PROVIDERS.has(value)
}

// -- Channel --
// Closed union: which sense/channel a session belongs to
export type Channel = "cli" | "teams" | "bluebubbles" | "inner" | "mcp"

// -- Integration --
// Closed union: which external service an action targets
export type Integration = "ado" | "github" | "graph"

const INTEGRATIONS: ReadonlySet<string> = new Set<Integration>(["ado", "github", "graph"])

export function isIntegration(value: unknown): value is Integration {
  return typeof value === "string" && INTEGRATIONS.has(value)
}

// -- External ID --
// Links an internal FriendRecord to an external system identity
export interface ExternalId {
  provider: IdentityProvider
  externalId: string
  tenantId?: string
  linkedAt: string // ISO date
}

export type TrustLevel = "family" | "friend" | "acquaintance" | "stranger"

/** Trust levels that grant full tool access and proactive send capability. */
export const TRUSTED_LEVELS: ReadonlySet<TrustLevel> = new Set(["family", "friend"])

/** Whether a trust level grants full access (family or friend). Defaults to "friend" for legacy records. */
export function isTrustedLevel(trustLevel?: TrustLevel): boolean {
  return TRUSTED_LEVELS.has(trustLevel ?? "friend")
}

export interface FriendConnection {
  name: string
  relationship: string
}

// -- Relationship Outcome --
// Records the result of a shared mission with an agent peer.
export interface RelationshipOutcome {
  missionId: string
  result: "success" | "partial" | "failed"
  timestamp: string
  note?: string
}

// -- Agent Meta --
// Extended metadata for friend records that represent agent peers.
export interface AgentMeta {
  bundleName: string
  familiarity: number
  sharedMissions: string[]
  outcomes: RelationshipOutcome[]
}

// -- Friend Record --
// The single merged type for a person the agent interacts with.
// Combines identity (who they are) and notes (what the agent has written about them).
// Stored as a unified JSON record in bundle `friends/`.
export interface FriendRecord {
  id: string                              // stable UUID
  name: string
  role?: string
  trustLevel?: TrustLevel
  connections?: FriendConnection[]
  externalIds: ExternalId[]               // PII
  tenantMemberships: string[]             // PII
  toolPreferences: Record<string, string> // keyed by integration name
  notes: Record<string, { value: string, savedAt: string }> // general friend knowledge (timestamped)
  totalTokens: number                     // cumulative token usage across all turns
  createdAt: string                       // ISO date
  updatedAt: string
  schemaVersion: number
  kind?: "human" | "agent"
  agentMeta?: AgentMeta
}

// -- Sense Type --
// Classifies how a channel is exposed to the outside world.
// "open" = anyone can reach the agent (e.g. iMessage/BlueBubbles)
// "closed" = org-gated, only authenticated users (e.g. Teams)
// "local" = direct terminal access (CLI)
// "internal" = agent-internal (inner dialog)
export type SenseType = "open" | "closed" | "local" | "internal"

// -- Channel Capabilities --
// What a channel supports: integrations, formatting, streaming, message limits
export interface ChannelCapabilities {
  channel: Channel
  senseType: SenseType
  availableIntegrations: Integration[]
  supportsMarkdown: boolean
  supportsStreaming: boolean
  supportsRichCards: boolean
  maxMessageLength: number
}

// -- Resolved Context --
// The per-request bundle resolved by the FriendResolver.
export interface ResolvedContext {
  readonly friend: FriendRecord
  readonly channel: ChannelCapabilities
  /** Whether the current conversation is a group chat (vs 1:1). Default false. */
  readonly isGroupChat?: boolean
}
