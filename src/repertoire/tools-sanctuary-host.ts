import * as path from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { FriendRecord } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"
import type { ProviderCapability } from "../heart/core"
import { validateHostProposalRequest, type HostProposalRequestV1 } from "../heart/daemon/sanctuary-host-authority"
import { loadSessionEnvelopeFile, selectEffectiveSessionEvents } from "../heart/session-events"
import { getSenseSessionPath } from "../senses/shared-turn"
import type { RootHostApprovalPort } from "../senses/root-host-approval-port"
import { loadRelationshipCapabilityRegistry } from "./relationship-authorization"
import { freezeToolValue } from "./tool-arguments"
import type { ToolContext, ToolDefinition } from "./tools-base"

export interface RootHostBinding {
  readonly agentRoot: string
  readonly friendId: string
  readonly requestId: string
  readonly sessionKey: string
  readonly sessionPath: string
  readonly sessionEventId: string
  readonly profileId: "sanctuary-owner"
  readonly profileVersion: number
  readonly keyId: string
  readonly publicKeyDigest: string
  readonly targetHost: string
}

export type RootHostSelectionContext = Pick<ToolContext, "agentName" | "agentRoot" | "rootHost" | "context" | "currentSession" | "currentExternalEvent"> & {
  relationshipAuthorization?: Pick<NonNullable<ToolContext["relationshipAuthorization"]>, "profileId" | "advertisedToolNames"> & Partial<NonNullable<ToolContext["relationshipAuthorization"]>>
}

const NAME = "sanctuary_host_execute"
const bindings = new WeakMap<RootHostBinding, { port: RootHostApprovalPort; recovery: boolean }>()
const selections = new WeakMap<ToolDefinition, { binding: RootHostBinding; capabilities: ReadonlySet<ProviderCapability> }>()

export class RootHostAuthorizationError extends Error {}

function requireOwner(condition: unknown): asserts condition {
  if (!condition) throw new RootHostAuthorizationError("Sanctuary root host authorization denied")
}

function ownerFriend(friend: FriendRecord | null | undefined, port: RootHostApprovalPort): asserts friend is FriendRecord {
  requireOwner(friend?.admissionState === "active" && friend.trustLevel === "family"
    && friend.initiativePolicy === "proactive" && friend.capabilityProfileId === "sanctuary-owner")
  const identities = friend.externalIds.filter((identity) => identity.provider === "telegram-user" && identity.tenantId === port.pins.expectedBotId)
  requireOwner(identities.length === 1 && identities[0]!.externalId === port.pins.expectedOwnerUserId)
}

function currentCoordinates(ctx: RootHostSelectionContext): RootHostBinding {
  const root = ctx.rootHost
  const relationship = ctx.relationshipAuthorization
  const actor = relationship?.actor
  const session = ctx.currentSession
  const friend = ctx.context?.friend
  requireOwner(ctx.agentName === "sanctuary" && typeof ctx.agentRoot === "string" && path.isAbsolute(ctx.agentRoot)
    && path.resolve(ctx.agentRoot) === ctx.agentRoot && path.basename(ctx.agentRoot) === "sanctuary.ouro")
  requireOwner(root && root.port.isHealthy() && !ctx.currentExternalEvent)
  requireOwner(relationship?.profileId === "sanctuary-owner" && relationship.advertisedToolNames?.includes(NAME))
  ownerFriend(friend, root.port)
  requireOwner(actor && actor.trustLevel === "family" && actor.friendId === friend.id && session?.friendId === friend.id
    && session.channel === "telegram" && ctx.context!.channel.channel === "telegram")
  requireOwner([friend.id, actor.sessionEventId, relationship.requestId, session.key].every((value) => typeof value === "string" && value.trim().length > 0))
  const sessionPath = getSenseSessionPath("sanctuary", friend.id, "telegram", session.key, ctx.agentRoot)
  requireOwner(session.sessionPath === sessionPath && sessionPath.startsWith(`${ctx.agentRoot}${path.sep}`))
  const envelope = loadSessionEnvelopeFile(sessionPath)
  const latest = envelope && selectEffectiveSessionEvents(envelope.events).findLast((event) => event.role === "user")
  requireOwner(latest && latest.id === actor.sessionEventId && latest.relations.references.includes(relationship.requestId!))
  const profile = loadRelationshipCapabilityRegistry(ctx.agentRoot).profiles["sanctuary-owner"]
  requireOwner(profile && Number.isSafeInteger(profile.version) && profile.version >= 9 && profile.toolNames.includes(NAME))
  return {
    agentRoot: ctx.agentRoot, friendId: friend.id, requestId: relationship.requestId!, sessionKey: session.key,
    sessionPath, sessionEventId: actor.sessionEventId, profileId: "sanctuary-owner", profileVersion: profile.version,
    keyId: root.port.pins.expectedKeyId, publicKeyDigest: root.port.pins.expectedPublicKeyDigest, targetHost: root.port.pins.expectedTargetHost,
  }
}

function observationAccepted(ctx: RootHostSelectionContext): boolean {
  const root = ctx.rootHost!
  return !!root.observation && root.port.acceptsObservation(root.observation)
    && root.observation.keyId === root.port.pins.expectedKeyId
    && root.observation.publicKeyDigest === root.port.pins.expectedPublicKeyDigest
    && root.observation.targetHost === root.port.pins.expectedTargetHost
}

export async function authorizeRootHostContext(ctx: ToolContext, expected?: RootHostBinding): Promise<RootHostBinding> {
  const previous = ctx.rootHost?.binding
  const provenance = previous && bindings.get(previous)
  if (previous) bindings.delete(previous)
  const coordinates = currentCoordinates(ctx)
  const root = ctx.rootHost!
  const port = root.port
  const relationship = ctx.relationshipAuthorization!
  const store = ctx.friendStore
  requireOwner(store && (expected ? isDeepStrictEqual(coordinates, expected) : observationAccepted(ctx)))
  const friend = await store.get(coordinates.friendId)
  ownerFriend(friend, port)
  requireOwner(friend.id === coordinates.friendId)
  const decision = await relationship.authorizeTool(NAME, {})
  requireOwner(decision.allowed && decision.profileId === coordinates.profileId && decision.profileVersion === coordinates.profileVersion
    && decision.friendId === coordinates.friendId && decision.requestId === coordinates.requestId
    && typeof decision.receiptId === "string" && decision.receiptId.trim().length > 0)
  requireOwner(ctx.rootHost === root && root.port === port && root.binding === previous && ctx.relationshipAuthorization === relationship && ctx.friendStore === store
    && isDeepStrictEqual(coordinates, currentCoordinates(ctx)) && (expected !== undefined || observationAccepted(ctx)))
  const binding = previous && provenance?.port === root.port && provenance.recovery === (expected !== undefined) && isDeepStrictEqual(previous, coordinates)
    ? previous : Object.freeze(coordinates)
  bindings.set(binding, { port: root.port, recovery: expected !== undefined })
  root.binding = binding
  return binding
}

const printable = (maximum: number) => ({ type: "string", minLength: 1, maxLength: maximum, pattern: "^[\\x20-\\x7e]+$" })
const argumentsSchema = { type: "array", maxItems: 64, items: printable(512) }
export const rootHostToolDefinition: ToolDefinition = freezeToolValue({
  tool: {
    type: "function",
    function: {
      name: NAME,
      description: "Propose one exact Sanctuary host command for root-owned owner approval. Nothing executes until root approval and signed permit verification. verification is optional and defaults to null.",
      parameters: {
        type: "object", additionalProperties: false,
        required: ["targetHost", "targetResource", "command", "workingDirectoryProfile", "environmentProfile", "timeoutMs"],
        properties: {
          targetHost: printable(256), targetResource: printable(256),
          command: {
            oneOf: [
              { type: "object", additionalProperties: false, required: ["kind", "executable", "arguments"], properties: {
                kind: { const: "executable" }, executable: printable(512), arguments: argumentsSchema,
              } },
              { type: "object", additionalProperties: false, required: ["kind", "interpreter", "arguments", "script"], properties: {
                kind: { const: "script" }, interpreter: printable(512), arguments: argumentsSchema,
                script: { type: "string", minLength: 1, maxLength: 2048, pattern: "^[\\x0a\\x20-\\x7e]+$" },
              } },
            ],
          },
          workingDirectoryProfile: { const: "host.root.v1" }, environmentProfile: { const: "host.clean.v1" },
          timeoutMs: { type: "integer", minimum: 1000, maximum: 900000 },
          verification: {
            type: "object", nullable: true, additionalProperties: false, required: ["profile", "expectedStateDigest"],
            properties: { profile: { const: "file.digest.v1" }, expectedStateDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" } },
          },
        },
      },
    },
  },
  requiredCapability: "approval-continuation",
  summaryKeys: ["targetHost", "targetResource"],
  riskProfile: { risk: "high", mutates: "external_side_effect", reason: "owner-approved arbitrary host command" },
  approvalPolicy: () => ({ kind: "required", policyId: "sanctuary.host.owner-approved.v1", actionClass: "owner_approved_arbitrary_host", requiresSoleCall: true }),
  handler: () => { throw new Error("Sanctuary host execution requires the root approval continuation; resident execution is forbidden") },
})

export function validateRootHostToolArguments(args: Record<string, unknown>, targetHost: string): Omit<HostProposalRequestV1, "ownerObservation"> {
  requireOwner(!Object.hasOwn(args, "ownerObservation"))
  const proposal = {
    ...args, verification: args.verification === undefined ? null : args.verification,
    ownerObservation: { digest: `sha256:${"0".repeat(64)}`, updateId: 0, userId: "1", chatId: "1", messageId: "1" },
  }
  // S4 owns command canonicalization. This placeholder only validates the model-owned fields.
  validateHostProposalRequest(proposal, targetHost)
  const { ownerObservation: _observation, ...command } = proposal
  return structuredClone(command)
}

export function selectRootHostTool(ctx?: RootHostSelectionContext, capabilities?: ReadonlySet<ProviderCapability>): ToolDefinition | undefined {
  try {
    const binding = ctx?.rootHost?.binding
    const provenance = binding && bindings.get(binding)
    if (!ctx || !binding || !provenance || provenance.port !== ctx.rootHost!.port || !capabilities?.has("approval-continuation")
      || !isDeepStrictEqual(binding, currentCoordinates(ctx)) || (!provenance.recovery && !observationAccepted(ctx))) return undefined
    const selected = Object.freeze({ ...rootHostToolDefinition })
    selections.set(selected, { binding, capabilities })
    return selected
  } catch {
    return undefined
  }
}

export async function authorizeRootHostToolInvocation(ctx: ToolContext | undefined, definition: ToolDefinition | undefined, args: Record<string, unknown>): Promise<void> {
  const selected = definition && selections.get(definition)
  requireOwner(ctx && selected && ctx.rootHost?.binding === selected.binding && ctx.toolSelection?.ordinary.includes(definition!))
  if (!ctx.rootHost.port.isHealthy() && !await ctx.rootHost.port.refresh()) throw new Error("Sanctuary root host authority is unavailable")
  requireOwner(selectRootHostTool(ctx, selected.capabilities))
  const provenance = bindings.get(selected.binding)!
  await authorizeRootHostContext(ctx, provenance.recovery ? selected.binding : undefined)
  requireOwner(selectRootHostTool(ctx, selected.capabilities))
  validateRootHostToolArguments(args, selected.binding.targetHost)
  emitNervesEvent({ component: "repertoire", event: "repertoire.sanctuary_host_invocation_admitted", message: "Owner host-tool invocation admitted to the root approval path" })
}
