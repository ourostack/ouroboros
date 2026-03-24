import type OpenAI from "openai";
import { emitNervesEvent } from "../nerves/runtime";
import type { ChannelCallbacks } from "./core";

export interface UsageData {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
}

// Azure Responses API item types (SDK doesn't export these)
// Anthropic thinking block types are also included for cross-provider compatibility
export type ResponseItem =
  | { type: "reasoning"; id: string; summary: { text: string; type: string }[]; encrypted_content?: string }
  | { type: "message"; id?: string; role: "assistant"; content: { type: string; text: string }[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string; status: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { role: "user"; content: string | Array<Record<string, unknown>> }
  | { role: "assistant"; content: string };

// Azure Responses API streaming event (untyped in SDK — use a flexible record)
interface ResponseStreamEvent {
  type: string;
  delta?: string;
  item?: Record<string, unknown>;
  response?: Record<string, unknown>;
}

// Azure Responses API usage shape
interface ResponseUsage {
  input_tokens: number;
  output_tokens: number;
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens: number;
}

// MiniMax streaming delta (has reasoning_content not in OpenAI SDK types)
interface StreamDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
}

export interface TurnResult {
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  outputItems: ResponseItem[];
  usage?: UsageData;
  settleStreamed?: boolean;
}

// Character-level state machine that extracts the answer value from
// `settle` tool call JSON arguments as they stream in.
// Scans for prefix `"answer":"` or `"answer": "` in the character stream,
// then emits text handling JSON escapes, stopping at unescaped closing `"`.
export class SettleParser {
  // Possible prefixes to match (with and without space after colon)
  private static readonly PREFIXES = ['"answer":"', '"answer": "'];
  // Buffer of characters seen so far (pre-activation only)
  private buf = "";
  private _active = false;
  private _complete = false;
  private inEscape = false;

  get active(): boolean { return this._active; }
  get complete(): boolean { return this._complete; }

  process(delta: string): string {
    if (this._complete) return "";
    let out = "";
    for (let i = 0; i < delta.length; i++) {
      const ch = delta[i];
      if (!this._active) {
        this.buf += ch;
        // Check if any prefix has been fully matched in the buffer
        for (const prefix of SettleParser.PREFIXES) {
          if (this.buf.endsWith(prefix)) {
            this._active = true;
            break;
          }
        }
      } else {
        // Active: emit characters, handling JSON escapes
        if (this.inEscape) {
          this.inEscape = false;
          switch (ch) {
            case '"': out += '"'; break;
            case '\\': out += '\\'; break;
            case 'n': out += '\n'; break;
            case 't': out += '\t'; break;
            case '/': out += '/'; break;
            default: out += ch; break; // unknown escape: pass through character
          }
        } else if (ch === '\\') {
          this.inEscape = true;
        } else if (ch === '"') {
          this._complete = true;
          return out; // stop processing, closing quote found
        } else {
          out += ch;
        }
      }
    }
    return out;
  }
}

// Shared helper: wraps SettleParser with onClearText + onTextChunk wiring.
// Used by all streaming providers (Chat Completions, Responses API, Anthropic)
// so the eager-match settle streaming pattern lives in one place.
export class SettleStreamer {
  private parser = new SettleParser();
  private _detected = false;
  private callbacks: ChannelCallbacks;
  private enabled: boolean;

  constructor(callbacks: ChannelCallbacks, enabled = true) {
    this.callbacks = callbacks;
    this.enabled = enabled;
  }

  get detected(): boolean { return this._detected; }
  get streamed(): boolean { return this.parser.active; }

  /** Mark settle as detected. Calls onClearText on the callbacks. */
  activate(): void {
    if (!this.enabled) return;
    if (this._detected) return;
    this._detected = true;
    this.callbacks.onClearText?.();
  }

  /** Feed an argument delta through the parser. Emits text via onTextChunk. */
  processDelta(delta: string): void {
    if (!this.enabled) return;
    if (!this._detected) return;
    const text = this.parser.process(delta);
    if (text) this.callbacks.onTextChunk(text);
  }
}

// Assistant message with optional reasoning items and phase (persisted through sessions)
export interface AssistantMessageWithReasoning extends OpenAI.ChatCompletionAssistantMessageParam {
  _reasoning_items?: ResponseItem[];
  phase?: "commentary" | "settle";
}

function toResponsesUserContent(
  content: OpenAI.ChatCompletionUserMessageParam["content"],
): string | Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return ""
  }

  const parts: Array<Record<string, unknown>> = []
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue
    }

    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "input_text", text: part.text })
      continue
    }

    if (part.type === "image_url") {
      const imageUrl = typeof part.image_url?.url === "string" ? part.image_url.url : ""
      if (!imageUrl) continue
      parts.push({
        type: "input_image",
        image_url: imageUrl,
        detail: part.image_url?.detail ?? "auto",
      })
      continue
    }

    if (
      part.type === "input_audio" &&
      typeof part.input_audio?.data === "string" &&
      (part.input_audio.format === "mp3" || part.input_audio.format === "wav")
    ) {
      parts.push({
        type: "input_audio",
        input_audio: {
          data: part.input_audio.data,
          format: part.input_audio.format,
        },
      })
      continue
    }

    if (part.type === "file") {
      const fileRecord: Record<string, unknown> = { type: "input_file" }
      if (typeof part.file?.file_data === "string") fileRecord.file_data = part.file.file_data
      if (typeof part.file?.file_id === "string") fileRecord.file_id = part.file.file_id
      if (typeof part.file?.filename === "string") fileRecord.filename = part.file.filename
      if (typeof part.file?.file_data === "string" || typeof part.file?.file_id === "string") {
        parts.push(fileRecord)
      }
    }
  }

  return parts.length > 0 ? parts : ""
}

export function toResponsesInput(
  messages: OpenAI.ChatCompletionMessageParam[],
): { instructions: string; input: ResponseItem[] } {
  let instructions = "";
  const input: ResponseItem[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      if (!instructions) {
        const sys = msg as OpenAI.ChatCompletionSystemMessageParam;
        instructions = (typeof sys.content === "string" ? sys.content : "") || "";
      }
      continue;
    }

    if (msg.role === "user") {
      const u = msg as OpenAI.ChatCompletionUserMessageParam;
      input.push({ role: "user", content: toResponsesUserContent(u.content) });
      continue;
    }

    if (msg.role === "assistant") {
      const a = msg as AssistantMessageWithReasoning;
      // Restore reasoning items before content (matching API item order)
      if (a._reasoning_items) {
        for (const ri of a._reasoning_items) {
          input.push(ri);
        }
      }
      if (a.content) {
        const assistantItem: Record<string, unknown> = { role: "assistant", content: typeof a.content === "string" ? a.content : "" };
        if (a.phase) assistantItem.phase = a.phase;
        input.push(assistantItem as ResponseItem);
      }
      if (a.tool_calls) {
        for (const tc of a.tool_calls) {
          /* v8 ignore next -- type narrowing: OpenAI SDK only emits function tool_calls @preserve */
          if (tc.type !== "function") continue;
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
            status: "completed",
          });
        }
      }
      continue;
    }

    if (msg.role === "tool") {
      const t = msg as OpenAI.ChatCompletionToolMessageParam;
      input.push({
        type: "function_call_output",
        call_id: t.tool_call_id,
        output: typeof t.content === "string" ? t.content : "",
      });
      continue;
    }
  }

  return { instructions, input };
}

export function toResponsesTools(
  ccTools: OpenAI.ChatCompletionFunctionTool[],
): { type: "function"; name: string; description: string | null; parameters: Record<string, unknown> | null; strict: false }[] {
  return ccTools.map((t) => ({
    type: "function" as const,
    name: t.function.name,
    description: t.function.description ?? null,
    parameters: (t.function.parameters as Record<string, unknown>) ?? null,
    strict: false as const,
  }));
}

export async function streamChatCompletion(
  client: OpenAI,
  createParams: Record<string, unknown>,
  callbacks: ChannelCallbacks,
  signal?: AbortSignal,
  eagerSettleStreaming = true,
): Promise<TurnResult> {
  emitNervesEvent({
    component: "engine",
    event: "engine.stream_start",
    message: "chat completion stream start",
    meta: {},
  });
  // Request usage data in the final streaming chunk
  createParams.stream_options = { include_usage: true };
  const response = await client.chat.completions.create(
    createParams as unknown as OpenAI.ChatCompletionCreateParams & { stream: true },
    signal ? { signal } : {},
  ) as AsyncIterable<OpenAI.ChatCompletionChunk>;

  let content = "";
  let toolCalls: Record<
    number,
    { id: string; name: string; arguments: string }
  > = {};
  let streamStarted = false;
  let usage: UsageData | undefined;
  const answerStreamer = new SettleStreamer(callbacks, eagerSettleStreaming);

  // State machine for parsing inline <think> tags (MiniMax pattern)
  let contentBuf = "";
  let inThinkTag = false;
  const OPEN_TAG = "<think>";
  const CLOSE_TAG = "</think>";

  function processContentBuf(flush: boolean): void {
    while (contentBuf.length > 0) {
      if (inThinkTag) {
        const end = contentBuf.indexOf(CLOSE_TAG);
        if (end !== -1) {
          const reasoning = contentBuf.slice(0, end);
          if (reasoning) callbacks.onReasoningChunk(reasoning);
          contentBuf = contentBuf.slice(end + CLOSE_TAG.length);
          inThinkTag = false;
        } else {
          // Check if buffer ends with a partial </think> prefix
          if (!flush) {
            let retain = 0;
            for (let i = 1; i < CLOSE_TAG.length && i <= contentBuf.length; i++) {
              if (contentBuf.endsWith(CLOSE_TAG.slice(0, i))) retain = i;
            }
            if (retain > 0) {
              const reasoning = contentBuf.slice(0, -retain);
              if (reasoning) callbacks.onReasoningChunk(reasoning);
              contentBuf = contentBuf.slice(-retain);
              return;
            }
          }
          // All reasoning, flush it
          callbacks.onReasoningChunk(contentBuf);
          contentBuf = "";
        }
      } else {
        const start = contentBuf.indexOf(OPEN_TAG);
        if (start !== -1) {
          const text = contentBuf.slice(0, start);
          if (text) callbacks.onTextChunk(text);
          contentBuf = contentBuf.slice(start + OPEN_TAG.length);
          inThinkTag = true;
        } else {
          // Check if buffer ends with a partial <think> prefix
          if (!flush) {
            let retain = 0;
            for (let i = 1; i < OPEN_TAG.length && i <= contentBuf.length; i++) {
              if (contentBuf.endsWith(OPEN_TAG.slice(0, i))) retain = i;
            }
            if (retain > 0) {
              const text = contentBuf.slice(0, -retain);
              if (text) callbacks.onTextChunk(text);
              contentBuf = contentBuf.slice(-retain);
              return;
            }
          }
          // All content, flush it
          callbacks.onTextChunk(contentBuf);
          contentBuf = "";
        }
      }
    }
  }

  for await (const chunk of response) {
    if (signal?.aborted) break;
    // Capture usage from final chunk (sent when stream_options.include_usage is true)
    if (chunk.usage) {
      const u = chunk.usage;
      usage = {
        input_tokens: u.prompt_tokens,
        output_tokens: u.completion_tokens,
        reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
        total_tokens: u.total_tokens,
      };
    }
    const d = chunk.choices[0]?.delta as StreamDelta | undefined;
    if (!d) continue;

    // Handle reasoning_content (Azure AI models like DeepSeek-R1)
    if (d.reasoning_content) {
      if (!streamStarted) {
        callbacks.onModelStreamStart();
        streamStarted = true;
      }
      callbacks.onReasoningChunk(d.reasoning_content);
    }

    if (d.content) {
      if (!streamStarted) {
        callbacks.onModelStreamStart();
        streamStarted = true;
      }
      content += d.content;
      contentBuf += d.content;
      processContentBuf(false);
    }
    if (d.tool_calls) {
      for (const tc of d.tool_calls) {
        if (!toolCalls[tc.index])
          toolCalls[tc.index] = {
            id: tc.id ?? "",
            name: tc.function?.name ?? "",
            arguments: "",
          };
        if (tc.id) toolCalls[tc.index].id = tc.id;
        if (tc.function?.name) {
          toolCalls[tc.index].name = tc.function.name;
          // Detect settle tool call on first name delta.
          // Only activate streaming if this is the sole tool call (index 0
          // and no other indices seen). Mixed calls are rejected by core.ts.
          if (tc.function.name === "settle" && !answerStreamer.detected
              && tc.index === 0 && Object.keys(toolCalls).length === 1) {
            answerStreamer.activate();
          }
        }
        if (tc.function?.arguments) {
          toolCalls[tc.index].arguments += tc.function.arguments;
          // Feed settle argument deltas to the parser for progressive
          // streaming, but only when it appears to be the sole tool call.
          if (answerStreamer.detected && toolCalls[tc.index].name === "settle"
              && Object.keys(toolCalls).length === 1) {
            answerStreamer.processDelta(tc.function.arguments);
          }
        }
      }
    }
  }
  // Flush any remaining buffer at end of stream
  if (contentBuf) processContentBuf(true);

  return {
    content,
    toolCalls: Object.values(toolCalls),
    outputItems: [],
    usage,
    settleStreamed: answerStreamer.streamed,
  };
}

export async function streamResponsesApi(
  client: OpenAI,
  createParams: Record<string, unknown>,
  callbacks: ChannelCallbacks,
  signal?: AbortSignal,
  eagerSettleStreaming = true,
): Promise<TurnResult> {
  emitNervesEvent({
    component: "engine",
    event: "engine.stream_start",
    message: "responses API stream start",
    meta: {},
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Azure Responses API not in OpenAI SDK types
  const response = await (client as any).responses.create(
    createParams,
    signal ? { signal } : {},
  ) as AsyncIterable<ResponseStreamEvent>;

  let content = "";
  let streamStarted = false;
  const toolCalls: { id: string; name: string; arguments: string }[] = [];
  const outputItems: ResponseItem[] = [];
  let currentToolCall: { call_id: string; name: string; arguments: string } | null = null;
  let usage: UsageData | undefined;
  const answerStreamer = new SettleStreamer(callbacks, eagerSettleStreaming);
  let functionCallCount = 0;

  for await (const event of response) {
    if (signal?.aborted) break;

    switch (event.type) {
      case "response.output_text.delta":
      case "response.reasoning_summary_text.delta": {
        if (!streamStarted) {
          callbacks.onModelStreamStart();
          streamStarted = true;
        }
        const delta = String(event.delta);
        if (event.type === "response.output_text.delta") {
          callbacks.onTextChunk(delta);
          content += delta;
        } else {
          callbacks.onReasoningChunk(delta);
        }
        break;
      }
      case "response.output_item.added": {
        if (event.item?.type === "function_call") {
          functionCallCount++;
          currentToolCall = {
            call_id: String(event.item.call_id),
            name: String(event.item.name),
            arguments: "",
          };
          // Detect settle function call -- clear any streamed noise.
          // Only activate when this is the first (and so far only) function call.
          // Mixed calls are rejected by core.ts; no need to stream their args.
          if (String(event.item.name) === "settle" && functionCallCount === 1) {
            answerStreamer.activate();
          }
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        if (currentToolCall) {
          currentToolCall.arguments += event.delta;
          // Feed settle argument deltas to the parser for progressive
          // streaming, but only when it appears to be the sole function call.
          if (answerStreamer.detected && currentToolCall.name === "settle"
              && functionCallCount === 1) {
            answerStreamer.processDelta(String(event.delta));
          }
        }
        break;
      }
      case "response.output_item.done": {
        outputItems.push(event.item as ResponseItem);
        if (event.item?.type === "function_call") {
          toolCalls.push({
            id: String(event.item.call_id),
            name: String(event.item.name),
            arguments: String(event.item.arguments),
          });
          currentToolCall = null;
        }
        break;
      }
      case "response.completed":
      case "response.done": {
        const u = event.response?.usage as ResponseUsage | undefined;
        if (u) {
          usage = {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            reasoning_tokens: u.output_tokens_details?.reasoning_tokens ?? 0,
            total_tokens: u.total_tokens,
          };
        }
        break;
      }
      default:
        // Unknown/unhandled events silently ignored
        break;
    }
  }

  return {
    content,
    toolCalls,
    outputItems,
    usage,
    settleStreamed: answerStreamer.streamed,
  };
}
