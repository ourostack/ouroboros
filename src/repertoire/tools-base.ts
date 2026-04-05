import type OpenAI from "openai";
import type { Integration, ResolvedContext } from "../mind/friends/types";
import type { FriendStore } from "../mind/friends/store";
import type { BridgeRecord, BridgeSessionRef } from "../heart/bridges/store";
import type { ActiveWorkFrame } from "../heart/active-work";

import { fileToolDefinitions } from "./tools-files";
import { shellToolDefinitions } from "./tools-shell";
import { memoryToolDefinitions } from "./tools-memory";
import { bridgeToolDefinitions } from "./tools-bridge";
import { sessionToolDefinitions } from "./tools-session";
import { continuityToolDefinitions } from "./tools-continuity";
import { configToolDefinitions } from "./tools-config";
import { codingToolDefinitions } from "./coding/tools";
// Re-export flow tools for consumers that import them from tools-base
export { ponderTool, observeTool, settleTool, restTool } from "./tools-flow";

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
  delegatedOrigins?: import("../heart/attention-types").AttentionItem[];
}

export type ToolHandler = (args: Record<string, string>, ctx?: ToolContext) => string | Promise<string>;

export interface ToolDefinition {
  tool: OpenAI.ChatCompletionFunctionTool;
  handler: ToolHandler;
  integration?: Integration;
  confirmationRequired?: boolean;
  confirmationAlwaysRequired?: boolean;
  requiredCapability?: import("../heart/core").ProviderCapability;
  summaryKeys?: string[];
}

// Tracks which file paths have been read via read_file in this session.
// edit_file requires a file to be read first (must-read-first guard).
export const editFileReadTracker = new Set<string>();

// Combined base tool definitions — assembled from category modules.
// Order preserved: files, shell, memory, bridge, session, continuity, config, coding.
export const baseToolDefinitions: ToolDefinition[] = [
  ...fileToolDefinitions,
  ...shellToolDefinitions,
  ...memoryToolDefinitions,
  ...bridgeToolDefinitions,
  ...sessionToolDefinitions,
  ...continuityToolDefinitions,
  ...configToolDefinitions,
  ...codingToolDefinitions,
];

// Convenience array of just the tool schemas (no handler/integration metadata).
// Used by consumers that need the OpenAI function-tool format.
export const tools: OpenAI.ChatCompletionFunctionTool[] = baseToolDefinitions.map((d) => d.tool);

/* v8 ignore start -- module-level nerves file-completeness event @preserve */
import { emitNervesEvent } from "../nerves/runtime"
emitNervesEvent({ component: "repertoire", event: "repertoire.module_loaded", message: "tools-base loaded", meta: {} })
/* v8 ignore stop */
