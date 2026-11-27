import type OpenAI from "openai";
import type { Integration, ResolvedContext, FriendStore } from "@ouro.bot/friends"
import type { BridgeRecord, BridgeSessionRef } from "../heart/bridges/store";
import type { ActiveWorkFrame } from "../heart/active-work";
import type { FlightRecorderProducedRef, HabitPermissionEnvelope, HabitSurfaceAttempt } from "../arc/flight-recorder";
import type { RsvpHabitRuntimePolicy } from "../rsvp/habit-policy";
import type { RoutineActionRequester } from "../heart/steward-policy";
import type { ApprovalOwnerBinding } from "../heart/approval-store";
import { emitNervesEvent } from "../nerves/runtime";
import type { McpToolBinding } from "./mcp-manager";

import { fileToolDefinitions } from "./tools-files";
import { shellToolDefinitions } from "./tools-shell";
import { webToolDefinitions } from "./tools-web";
import { notesToolDefinitions } from "./tools-notes";
import { recordToolDefinitions } from "./tools-record";
import { bridgeToolDefinitions } from "./tools-bridge";
import { sessionToolDefinitions } from "./tools-session";
import { continuityToolDefinitions } from "./tools-continuity";
import { configToolDefinitions } from "./tools-config";
import { codingToolDefinitions } from "./coding/tools"
import { credentialToolDefinitions } from "./tools-credential"
import { vaultToolDefinitions } from "./tools-vault"
import { travelToolDefinitions } from "./tools-travel";
import { userProfileToolDefinitions } from "./tools-user-profile";
import { stripeToolDefinitions } from "./tools-stripe";
import { flightToolDefinitions } from "./tools-flight";
import { attachmentToolDefinitions } from "./tools-attachments";
import { tripToolDefinitions } from "./tools-trip"
import { a2aToolDefinitions } from "./tools-a2a"
import { commerceToolDefinitions } from "./tools-commerce"
import { awaitingToolDefinitions } from "./tools-awaiting"
import { reportFailureToolDefinition } from "./tools-escalation"
import { obligationToolDefinitions } from "./tools-obligations"
import { evolutionToolDefinitions } from "./tools-evolution"
import { runtimeToolDefinitions } from "./tools-runtime"
import { orientationToolDefinitions } from "./tools-orientation"
import { rsvpToolDefinitions } from "./tools-rsvp"
import { habitToolDefinitions } from "./tools-habits"
import { telegramContactToolDefinition } from "./tools-telegram-contacts"
import { friendLinkToolDefinition } from "./tools-friend-link"
import type { OrientationFrame } from "../heart/orientation-frame"
// Re-export flow tools for consumers that import them from tools-base
export { ponderTool, observeTool, settleTool, restTool, speakTool } from "./tools-flow";

// Re-export renderInnerProgressStatus for consumers
export { renderInnerProgressStatus } from "./tools-session";
export { routineActionRequester } from "./relationship-authorization";
export type { RoutineActionRequester } from "../heart/steward-policy";

/** The friend id of the agent talking to itself: every private-runtime turn (awaits and its own reflection) runs with this friend. */
export const SELF_FRIEND_ID = "self"

export interface CodingFeedbackTarget {
  send: (message: string) => Promise<void>;
}

/** Where the agent's reply lands: where the app would put it, in the main chat, or as a reply to one message. */
export type ReplyTargetSelection =
  | { target: "current_lane" }
  | { target: "top_level" }
  | { target: "thread"; messageId: string }

/** What the agent asks for; a thread reply without a message answers the message that started the turn. */
export type ReplyTargetRequest =
  | { target: "current_lane" }
  | { target: "top_level" }
  | { target: "thread"; messageId?: string }

/**
 * What the agent can do in the chat this turn came from. Each sense binds it per turn; a missing method means the app
 * can't. A left-out message id means the message that started the turn.
 */
export interface ChatActions {
  react?: (emoji: string, messageId?: string) => Promise<string>;
  setReplyTarget?: (request: ReplyTargetRequest) => string;
  /** Sends a local file into this chat; resolves to what the agent should hear about it, and throws if it didn't go. */
  sendFile?: (path: string, caption: string) => Promise<string>;
}

/** A sense's own chat actions, which always name the message. */
export interface SenseChatActions {
  react?: (emoji: string, messageId: string) => Promise<string>;
  setReplyTarget?: (selection: ReplyTargetSelection) => string;
  sendFile?: ChatActions["sendFile"];
}

export interface VoiceCallAudioRequest {
  source?: "tone" | "url" | "file";
  url?: string;
  path?: string;
  label?: string;
  toneHz?: number;
  durationMs?: number;
}

export interface VoiceCallAudioResult {
  label: string;
  durationMs: number;
  toolResult?: string;
}

export interface VoiceCallControl {
  requestEnd: (reason?: string) => Promise<void> | void;
  playAudio?: (request: VoiceCallAudioRequest) => Promise<VoiceCallAudioResult> | VoiceCallAudioResult;
}

export interface HabitSessionToolContext {
  runId?: string;
  sessionPath?: string;
  pendingDir?: string;
  permissionEnvelope: HabitPermissionEnvelope;
  rsvpPolicy?: RsvpHabitRuntimePolicy;
  friendStore?: FriendStore;
  recordProducedRef?: (ref: FlightRecorderProducedRef) => void;
  recordSurfaceAttempt?: (attempt: HabitSurfaceAttempt) => void;
  recordError?: (error: string) => void;
  readonly noSend?: true;
}

/** An image a tool returns alongside its text result (base64 data, not a data URL). */
export interface ToolResultImage {
  data: string
  mimeType: string
}

export interface ToolContext {
  /** Set by the engine for one tool call: hands images from the result to the model. */
  attachToolImages?: (images: ToolResultImage[]) => void;
  /** Set by the engine for one tool call: called once every guard has passed, just before the handler runs. */
  beforeHandler?: () => void;
  /** A validated immutable terminal locator, not relationship authority. */
  readonly currentShepherdSurface?: import("../senses/shepherd/surface").ShepherdSession;
  /** Trusted turn-local subtraction from the normal engine menu; never grants a tool. */
  readonly allowedEngineTools?: readonly string[];
  graphToken?: string;
  adoToken?: string;
  githubToken?: string;
  /** Connections whose sign-in the sense knows cannot start, with the reason to tell the person. */
  oauthUnavailable?: Readonly<Record<string, string>>;
  /** Logical OAuth services whose adapter can actually start sign-in this turn; a no-op signin is not capability. */
  oauthAvailable?: readonly string[];
  signin: (connectionName: string) => Promise<string | undefined>;
  context?: ResolvedContext;
  friendStore?: FriendStore;
  summarize?: (transcript: string, instruction: string) => Promise<string>;
  codingFeedback?: CodingFeedbackTarget;
  tenantId?: string;
  // Bot Framework API client for proactive messaging (Teams channel only).
  // Provides conversations.create() and conversations.activities().create().
  // Uses `unknown` wrapper to avoid coupling to @microsoft/teams.api types.
  botApi?: {
    id: string;
    conversations: unknown;
  };
  chatActions?: ChatActions;
  currentSession?: BridgeSessionRef;
  /**
   * Set only by the private runtime for a turn that is ticking exactly one await. The inbound pipeline replaces
   * `currentSession` with the private-runtime session, so this carries the await's own relationship binding instead.
   */
  readonly awaitTick?: Readonly<{ awaitName: string; friendId: string; channel: string; key: string; requestId: string | null }>;
  activeBridges?: BridgeRecord[];
  activeWorkFrame?: ActiveWorkFrame;
  supportedReasoningEfforts?: readonly string[];
  setReasoningEffort?: (level: string) => void;
  delegatedOrigins?: import("../arc/attention-types").AttentionItem[];
  voiceCall?: VoiceCallControl;
  orientationFrame?: OrientationFrame;
  /** Immutable locator for the durable v1 capture that started this turn. */
  readonly currentIngressEvidence?: Readonly<{
    schemaVersion: 1;
    provider: "bluebubbles";
    captureKeyHash: string;
  }>;
  readonly currentExternalEvent?: Readonly<import("../heart/external-events/router").ExternalEventLeaseContext>;
  readonly externalEventAuthority?: Readonly<{
    authorizeDisposition(input: {
      event: import("../heart/external-events/router").ExternalEventLeaseContext;
      classification: string;
      decision: string;
      stewardPolicy: import("../heart/external-events/router").ExternalEventDisposition["stewardPolicy"];
      nextWake: string;
      wakeAt: string | null;
      awaitId: string | null;
      careId: string | null;
      actionRefs: string[];
      verificationRefs: string[];
    }): { allowed: boolean; reason: string };
    recordCommittedDisposition?(event: import("../heart/external-events/router").ExternalEventLeaseContext): void;
  }>;
  readonly externalEventEffects?: Readonly<{
    /** relatedEvents are the rest of the dispatched batch; one owner message speaks for the whole batch. */
    deliverOwnerDecision(input: {
      source: string; eventId: string; generation: number; text: string;
      relatedEvents: Array<{ source: string; eventId: string; generation: number }>;
    }): Promise<import("../heart/external-events/router").ExternalEventOwnerMessage>;
  }>;
  /** Irrevocable per-turn capability reduction used by transport-safe probes. */
  readonly noSend?: true;
  habitSession?: HabitSessionToolContext;
  /** Set only on autonomous private-runtime turns (no person present); absent on owner-initiated turns. */
  /** The name of the await this turn ticks, set by the private runtime for every await turn (relationship or system). */
  readonly autonomousAwaitName?: string;
  readonly autonomousTurnKind?: "await" | "habit" | "external-event" | "instinct" | "scheduler";
  /**
   * Where the turn came from, set by the code that starts it and never by a caller: "sense-ingress" for a person's
   * message a sense received (BlueBubbles), "socket" for a turn a daemon socket client asked for (agent.senseTurn,
   * agent.ask, MCP send_message). The socket's caller picks its own friendId and channel, so nothing that must know a
   * person is present may trust those on a "socket" turn (mailbox design §3.4).
   */
  readonly turnOrigin?: "sense-ingress" | "socket";
  daemonSocketPath?: string;
  agentName?: string;
  agentRoot?: string;
  rootHost?: {
    port: import("../senses/root-host-approval-port").RootHostApprovalPort;
    observation?: import("../senses/telegram-client").TelegramAuthorityTransportMetadata;
    /** Opaque to core: the Butler's root-host tool makes, reads and compares it by identity, and owns its shape. */
    binding?: object;
  };
  readonly toolSelection?: ToolSelection;
  readonly selectCurrentTools?: () => ToolSelection;
  currentUserMessage?: string;
  /** Exact attachments bound to the current ingress; when present, attachment tools fail closed outside it. */
  attachmentIds?: readonly string[];
  /** Relationship-scoped capability envelope: advertise narrowly, then revalidate at execution. */
  relationshipAuthorization?: {
    readonly requestId?: string;
    readonly profileId?: string;
    readonly resolveCurrent?: () => Promise<NonNullable<ToolContext["relationshipAuthorization"]>>;
    authorizedContextScopes: readonly string[];
    advertisedToolNames: readonly string[];
    authorizeTool(name: string, args: Record<string, string>): { allowed: true; receiptId: string; profileVersion?: number; friendId?: string; profileId?: string; requestId?: string | null } | { allowed: false; reason: string } | Promise<{ allowed: true; receiptId: string; profileVersion?: number; friendId?: string; profileId?: string; requestId?: string | null } | { allowed: false; reason: string }>;
    readonly actor?: Readonly<{ friendId: string; trustLevel: import("@ouro.bot/friends").TrustLevel; sessionEventId: string }>;
  };
  /** Delivery checks on settle answers, opted in per agent profile (the Sanctuary tool context sets both). Absent means off. */
  answerGates?: { sourceGrounding?: boolean; brevity?: boolean; shelfClaims?: boolean };
  /** Set only by the A2A server after it admitted a delegated principal command. */
  readonly delegatedCommand?: Readonly<import("../a2a/delegated-command").DelegatedCommandContext>;
  commerceAuthority?: {
    checkoutId: string;
    reservationToken: string;
  };
  sanctuary?: {
    listContainers(): Promise<unknown>;
    getContainerLogs(args: { container: string; tailLines: number }): Promise<unknown>;
    getStorage(): Promise<unknown>;
    getDisks(): Promise<unknown>;
    getNotifications(): Promise<unknown>;
    getSystem(): Promise<unknown>;
    getInstallState(): Promise<unknown>;
    checkServices(): Promise<unknown>;
    getDownloadQueue(): Promise<unknown>;
    getMediaOptimization(): Promise<unknown>;
    searchMediaCatalog(args: { query?: string; limit?: number }): Promise<unknown>;
    resumeDownloadQueue(): Promise<unknown>;
    restartContainer(args: { container: string }, execution?: import("./unraid-restart").UnraidRestartExecution): Promise<unknown>;
    recoverRoutineActions?(): Promise<unknown>;
  };
  /** Immutable standing-policy selection made before this exact tool dispatch. */
  routineActionSelection?: Readonly<
    | { kind: "standing"; agentRoot: string; key: string; target: string; expectedPolicyVersion: number; expectedDesiredStateVersion: number; expectedGrantVersion: number; requester: RoutineActionRequester; authorizationVersion: number }
    | { kind: "denied"; reason: string }
  >;
  restartApproval?: Readonly<{
    approvalId: string;
    agentRoot: string;
    sessionPath: string;
    ownerBinding: Readonly<ApprovalOwnerBinding>;
    argumentDigest: string;
    target: Readonly<{ id: string; name: string }>;
  }>;
  telegramContactManager?: {
    list(input: { actorFriendId: string }): Promise<{ contacts: unknown[]; blocked: unknown[] }>;
    revoke(input: { actorFriendId: string; friendId: string }): Promise<{ revoked: true; friendId: string }>;
    unblock(input: { actorFriendId: string; admissionId: string }): Promise<{ unblocked: true; admissionId: string }>;
  };
}

export { withCode } from "./tool-error-code";

export function routineActionDenied(reason: string): string {
  const message = reason.slice(0, 500)
  emitNervesEvent({ component: "repertoire", event: "repertoire.routine_action_denied", message: "routine action denied", meta: { reason: message } })
  return JSON.stringify({ ok: false, error: { code: "routine_action_denied", message, degraded: true } })
}

export type ToolHandler = (args: Record<string, string>, ctx?: ToolContext) => string | Promise<string>;
export type ToolMutationKind = "none" | "private_attention_write" | "durable_state_write" | "external_side_effect"
export type ToolHighRiskMutationKind = Exclude<ToolMutationKind, "none">

export type ToolRiskProfile =
  | { mutates: "none"; risk: "low"; reason?: string }
  | { mutates: ToolHighRiskMutationKind | readonly ToolHighRiskMutationKind[]; risk: "high"; reason: string }

export type ToolRiskProfileResolver = (args: Record<string, string>) => ToolRiskProfile

export type ToolApprovalPolicy =
  | { kind: "not_required" }
  | {
      kind: "required"
      policyId: string
      actionClass: string
      requiresSoleCall: true
    }

export type ToolApprovalPolicyResolver = (args: Record<string, unknown>) => ToolApprovalPolicy

/** What can go wrong at a tool, as the model reads it: the census's `ErrorCard`. */
export interface ToolErrorCard {
  code: string;
  means: string;
  fix: string;
}

/**
 * A tool's Ouro AX declaration: the census's `DoorCard`, with the tool's id `tool:<name>`. `when` says when a model
 * should pick this tool over its neighbours; `effect` is its consent class, and `consequential` is for exactly the
 * tools with an `approvalPolicy`, whose `confirm` is the approval question. A bare schema with no definition (an
 * engine tool) keeps its card in its module's exported `toolCards` list instead.
 */
export interface ToolDoorCard {
  id: `tool:${string}`;
  group: string;
  when: string;
  effect: "read" | "write" | "consequential" | "person-only";
  errors: readonly ToolErrorCard[];
  destructive?: true;
  idempotent?: true;
  confirm?: string;
  eager?: true;
}

export interface ToolDefinition {
  tool: OpenAI.ChatCompletionFunctionTool;
  /** The tool's Ouro AX card, which the AX census checks (ax/census.config.json). */
  ax: ToolDoorCard;
  handler: ToolHandler;
  integration?: Integration;
  requiredCapability?: import("../heart/core").ProviderCapability;
  summaryKeys?: string[];
  riskProfile?: ToolRiskProfile | ToolRiskProfileResolver;
  approvalPolicy?: ToolApprovalPolicyResolver;
  terminalProjection?: {
    mode: "verbatim";
    requiresSoleCall: true;
    clearBufferedText: true;
  };
  /** For first-class MCP tools: the server this tool belongs to. */
  mcpServer?: string;
  mcpBinding?: McpToolBinding;
  /**
   * The tool's own admission check. The dispatcher calls it after the arguments pass the advertised schema and before
   * relationship authorization and the handler, and a throw rejects the call before the handler, with the error's message.
   */
  authorize?(ctx: ToolContext | undefined, args: Record<string, unknown>): Promise<void>;
  /**
   * Set only on a tool whose `authorize` also authorizes the turn's relationship itself (the root-host tool, whose
   * authorization records the relationship's receipt and binds to the selected definition). The dispatcher then doesn't
   * ask the relationship again, checks the call against the turn's own selection instead of a fresh one, and a selection
   * keeps the very definition it was given (not a frozen copy). It needs `authorize`; without it nothing changes.
   */
  authorizesRelationship?: true;
}

export interface ToolSelection {
  readonly ordinary: readonly ToolDefinition[];
  readonly engine: readonly OpenAI.ChatCompletionFunctionTool[];
}

export type ToolExecutionOutcome =
  | { kind: "handler_succeeded"; text: string }
  | { kind: "rejected_before_handler" | "handler_failed" | "handler_indeterminate"; text: string; error?: unknown };

// Tracks which file paths have been read via read_file in this session.
// edit_file requires a file to be read first (must-read-first guard).
export const editFileReadTracker = new Set<string>();

// Combined base tool definitions — assembled from category modules.
// Order preserved: files, shell, notes, bridge, session, continuity, config, coding.
export const baseToolDefinitions: ToolDefinition[] = [
  ...fileToolDefinitions,
  ...shellToolDefinitions,
  ...webToolDefinitions,
  ...notesToolDefinitions,
  ...recordToolDefinitions,
  ...bridgeToolDefinitions,
  ...sessionToolDefinitions,
  ...continuityToolDefinitions,
  ...configToolDefinitions,
  ...codingToolDefinitions,
  ...credentialToolDefinitions,
  ...vaultToolDefinitions,
  ...travelToolDefinitions,
  ...userProfileToolDefinitions,
  ...stripeToolDefinitions,
  ...flightToolDefinitions,
  ...attachmentToolDefinitions,
  ...tripToolDefinitions,
  ...a2aToolDefinitions,
  ...commerceToolDefinitions,
  ...awaitingToolDefinitions,
  reportFailureToolDefinition,
  ...obligationToolDefinitions,
  ...evolutionToolDefinitions,
  ...orientationToolDefinitions,
  ...runtimeToolDefinitions,
  ...rsvpToolDefinitions,
  ...habitToolDefinitions,
  telegramContactToolDefinition,
  friendLinkToolDefinition,
];

// Convenience array of just the tool schemas (no handler/integration metadata).
// Used by consumers that need the OpenAI function-tool format.
export const tools: OpenAI.ChatCompletionFunctionTool[] = baseToolDefinitions.map((d) => d.tool);
