import type OpenAI from "openai";
import type { Integration, ResolvedContext } from "../mind/friends/types";
import type { FriendStore } from "../mind/friends/store";
import type { BridgeRecord, BridgeSessionRef } from "../heart/bridges/store";
import type { ActiveWorkFrame } from "../heart/active-work";

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
import { awaitingToolDefinitions } from "./tools-awaiting"
import { obligationToolDefinitions } from "./tools-obligations"
import { runtimeToolDefinitions } from "./tools-runtime"
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
}

export type ToolHandler = (args: Record<string, string>, ctx?: ToolContext) => string | Promise<string>;

export interface ToolDefinition {
  tool: OpenAI.ChatCompletionFunctionTool;
  handler: ToolHandler;
  integration?: Integration;
  requiredCapability?: import("../heart/core").ProviderCapability;
  summaryKeys?: string[];
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
  ...awaitingToolDefinitions,
  ...obligationToolDefinitions,
  ...runtimeToolDefinitions,
];

// Convenience array of just the tool schemas (no handler/integration metadata).
// Used by consumers that need the OpenAI function-tool format.
export const tools: OpenAI.ChatCompletionFunctionTool[] = baseToolDefinitions.map((d) => d.tool);
