import type OpenAI from "openai";
import type { Integration, ResolvedContext, FriendStore } from "@ouro.bot/friends"
import type { BridgeRecord, BridgeSessionRef } from "../heart/bridges/store";
import type { ActiveWorkFrame } from "../heart/active-work";
import type { FlightRecorderProducedRef, HabitPermissionEnvelope, HabitSurfaceAttempt, HabitToolPolicy } from "../arc/flight-recorder";
import type { RsvpHabitRuntimePolicy } from "../rsvp/habit-policy";

import { fileToolDefinitions } from "./tools-files";
import { shellToolDefinitions } from "./tools-shell";
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
import { mailToolDefinitions } from "./tools-mail"
import { tripToolDefinitions } from "./tools-trip"
import { a2aToolDefinitions } from "./tools-a2a"
import { commerceToolDefinitions } from "./tools-commerce"
import { awaitingToolDefinitions } from "./tools-awaiting"
import { obligationToolDefinitions } from "./tools-obligations"
import { evolutionToolDefinitions } from "./tools-evolution"
import { runtimeToolDefinitions } from "./tools-runtime"
import { orientationToolDefinitions } from "./tools-orientation"
import { rsvpToolDefinitions } from "./tools-rsvp"
import { habitToolDefinitions } from "./tools-habits"
import type { OrientationFrame } from "../heart/orientation-frame"
// Re-export flow tools for consumers that import them from tools-base
export { ponderTool, observeTool, settleTool, restTool, speakTool } from "./tools-flow";

// Re-export renderInnerProgressStatus for consumers
export { renderInnerProgressStatus } from "./tools-session";

export interface CodingFeedbackTarget {
  send: (message: string) => Promise<void>;
}

export type BlueBubblesReplyTargetSelection =
  | { target: "current_lane" }
  | { target: "top_level" }
  | { target: "thread"; threadOriginatorGuid: string }

export interface BlueBubblesReplyTargetController {
  setSelection: (selection: BlueBubblesReplyTargetSelection) => string;
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
  toolPolicy: HabitToolPolicy;
  rsvpPolicy?: RsvpHabitRuntimePolicy;
  friendStore?: FriendStore;
  recordProducedRef?: (ref: FlightRecorderProducedRef) => void;
  recordSurfaceAttempt?: (attempt: HabitSurfaceAttempt) => void;
  recordError?: (error: string) => void;
  readonly noSend?: true;
}

export interface ToolContext {
  graphToken?: string;
  adoToken?: string;
  githubToken?: string;
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
  bluebubblesReplyTarget?: BlueBubblesReplyTargetController;
  currentSession?: BridgeSessionRef;
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
  }>;
  readonly externalEventEffects?: Readonly<{
    deliverOwnerDecision(input: { eventId: string; generation: number; text: string }): Promise<void>;
  }>;
  /** Irrevocable per-turn capability reduction used by transport-safe probes. */
  readonly noSend?: true;
  habitSession?: HabitSessionToolContext;
  daemonSocketPath?: string;
  agentRoot?: string;
  currentUserMessage?: string;
  /** Relationship-scoped capability envelope: advertise narrowly, then revalidate at execution. */
  relationshipAuthorization?: {
    authorizedContextScopes: readonly string[];
    advertisedToolNames: readonly string[];
    authorizeTool(name: string, args: Record<string, string>): { allowed: true; receiptId: string; profileVersion?: number } | { allowed: false; reason: string } | Promise<{ allowed: true; receiptId: string; profileVersion?: number } | { allowed: false; reason: string }>;
    readonly actor?: Readonly<{ friendId: string; trustLevel: import("@ouro.bot/friends").TrustLevel; sessionEventId: string }>;
  };
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
    restartContainer(args: { container: string }, execution?: { routine?: import("./unraid-restart").RoutineRestartAuthority }): Promise<unknown>;
    recoverRoutineActions?(): Promise<unknown>;
  };
  /** Immutable standing-policy selection made before this exact tool dispatch. */
  routineActionSelection?: Readonly<{ key: string; target: string; expectedPolicyVersion: number }>;
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

export interface ToolDefinition {
  tool: OpenAI.ChatCompletionFunctionTool;
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
}

// Tracks which file paths have been read via read_file in this session.
// edit_file requires a file to be read first (must-read-first guard).
export const editFileReadTracker = new Set<string>();

// Combined base tool definitions — assembled from category modules.
// Order preserved: files, shell, notes, bridge, session, continuity, config, coding.
export const baseToolDefinitions: ToolDefinition[] = [
  ...fileToolDefinitions,
  ...shellToolDefinitions,
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
  ...mailToolDefinitions,
  ...tripToolDefinitions,
  ...a2aToolDefinitions,
  ...commerceToolDefinitions,
  ...awaitingToolDefinitions,
  ...obligationToolDefinitions,
  ...evolutionToolDefinitions,
  ...orientationToolDefinitions,
  ...runtimeToolDefinitions,
  ...rsvpToolDefinitions,
  ...habitToolDefinitions,
];

// Convenience array of just the tool schemas (no handler/integration metadata).
// Used by consumers that need the OpenAI function-tool format.
export const tools: OpenAI.ChatCompletionFunctionTool[] = baseToolDefinitions.map((d) => d.tool);
