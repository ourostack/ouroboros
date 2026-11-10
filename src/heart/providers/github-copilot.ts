import OpenAI from "openai";
import { getGithubCopilotConfig, type GithubCopilotProviderConfig } from "../config";
import { emitNervesEvent } from "../../nerves/runtime";
import type { ProviderCapability, ProviderErrorClassification, ProviderRuntime, ProviderTurnRequest } from "../core";
import type { ResponseItem, TurnResult } from "../streaming";
import { streamChatCompletion, streamResponsesApi, toResponsesInput, toResponsesTools, truncateResponsesFunctionCallOutput } from "../streaming";
import { getModelCapabilities } from "../model-capabilities";
import { classifyHttpError } from "./error-classification";
import * as path from "path";
import { AccountPool, createPooledCaller, fetchDirectReadings, getAccountPool, parseAccountPool, type PooledCaller } from "./account-pool";
import { loadFleetQuota, mergeReadings, publishAgentBurn } from "../quota/fleet-readings";

export function classifyGithubCopilotError(error: Error): ProviderErrorClassification {
  return classifyHttpError(error)
}


const IMAGE_PART_PATTERN = /"type"\s*:\s*"(?:image_url|input_image)"/

/**
 * Copilot rejects a request that contains images unless it carries `Copilot-Vision-Request: true`.
 * Add it only to requests whose JSON body holds an image part.
 */
export function withCopilotVisionHeader(fetchImpl?: typeof fetch): typeof fetch {
  return (input, init) => {
    const send = fetchImpl ?? globalThis.fetch
    if (typeof init?.body !== "string" || !IMAGE_PART_PATTERN.test(init.body)) return send(input, init)
    const headers = new Headers(init.headers)
    headers.set("Copilot-Vision-Request", "true")
    return send(input, { ...init, headers })
  }
}

export interface GithubCopilotRuntimeOwner {
  agentName: string;
  agentRoot: string;
}

/**
 * The agent's account pool for this turn, when `ouro auth` discovered one; null for a single account.
 * Without an owning agent (a daemon-side ping, provider discovery) the pool still switches on a 402 or 429,
 * but keeps no state between calls, writes no switch log and publishes nothing.
 */
export function createGithubCopilotPooledCaller(config: GithubCopilotProviderConfig, owner?: GithubCopilotRuntimeOwner): PooledCaller<OpenAI> | null {
  const accounts = parseAccountPool(config.accountPool);
  if (accounts.length === 0) return null;
  const makeClient = (account: { githubToken: string; baseUrl: string }) => new OpenAI({ apiKey: account.githubToken, baseURL: account.baseUrl, maxRetries: 0, fetch: withCopilotVisionHeader() });
  if (!owner) return createPooledCaller(new AccountPool(accounts, { agent: "(unowned)", switchLog: "", appendLine: () => {} }), makeClient);
  const gist = config.fleetGistId && config.fleetGistToken ? { gistId: config.fleetGistId, token: config.fleetGistToken } : null;
  const pool = getAccountPool(accounts, {
    agent: owner.agentName,
    machine: config.fleetMachine,
    switchLog: path.join(owner.agentRoot, "state", "account-switches.jsonl"),
    burnDir: path.join(owner.agentRoot, "state", "account-burn"),
    refusalsFile: path.join(owner.agentRoot, "state", "account-refusals.json"),
    publishedFile: path.join(owner.agentRoot, "state", "account-burn-published.json"),
    readingsFile: path.join(owner.agentRoot, "state", "account-readings.json"),
    /* v8 ignore start -- network readers and publisher: each is tested in its own module @preserve */
    loadReadings: async () => mergeReadings(await loadFleetQuota(gist), await fetchDirectReadings(accounts)),
    publishBurn: gist ? (burn) => publishAgentBurn(gist, burn) : undefined,
    /* v8 ignore stop */
  });
  return createPooledCaller(pool, makeClient);
}

export function createGithubCopilotProviderRuntime(
  model: string,
  config: GithubCopilotProviderConfig = getGithubCopilotConfig(),
  owner?: GithubCopilotRuntimeOwner,
): ProviderRuntime {
  emitNervesEvent({
    component: "engine",
    event: "engine.provider_init",
    message: "github-copilot provider init",
    meta: { provider: "github-copilot" },
  });
  if (!config.githubToken) {
    throw new Error(
      "provider 'github-copilot' is selected but github-copilot.githubToken is missing in the agent vault. Run `ouro auth --agent <agent> --provider github-copilot`.",
    );
  }
  if (!config.baseUrl) {
    throw new Error(
      "provider 'github-copilot' is selected but github-copilot.baseUrl is missing in the agent vault. Run `ouro auth --agent <agent> --provider github-copilot`.",
    );
  }

  const isCompletionsModel = model.startsWith("claude");
  const modelCaps = getModelCapabilities(model);
  const capabilities = new Set<ProviderCapability>();
  /* v8 ignore next -- branch: capability detection tested via unit test @preserve */
  if (modelCaps.reasoningEffort) capabilities.add("reasoning-effort");

  // With an account pool the account is chosen here, between turns; a 402 or 429 moves it mid-request.
  const pooled = createGithubCopilotPooledCaller(config, owner);
  const client = pooled ? pooled.client() : new OpenAI({
    apiKey: config.githubToken,
    baseURL: config.baseUrl,
    maxRetries: 0,
    fetch: withCopilotVisionHeader(),
  });
  const callModel = <T>(fallback: OpenAI, request: (client: OpenAI) => Promise<T>): Promise<T> =>
    pooled ? pooled.call((pooledClient) => request(pooledClient)) : request(fallback);

  if (isCompletionsModel) {
    // Chat completions path (Claude models via Copilot)
    return {
      id: "github-copilot",
      model,
      client,
      capabilities,
      supportedReasoningEfforts: modelCaps.reasoningEffort,
      resetTurnState(_messages: OpenAI.ChatCompletionMessageParam[]): void {
        // No provider-owned turn state for chat-completions path.
      },
      appendToolOutput(_callId: string, _output: string): void {
        // Chat-completions providers rely on canonical messages only.
      },
      /* v8 ignore start -- streamTurn: tested via mock assertions in github-copilot.test.ts @preserve */
      async streamTurn(request: ProviderTurnRequest): Promise<TurnResult> {
        const params: Record<string, unknown> = {
          messages: request.messages,
          tools: request.activeTools,
          stream: true,
        };
        if (this.model) params.model = this.model;
        if (request.traceId) params.metadata = { trace_id: request.traceId };
        // Copilot's Claude models think adaptively, and thinking only accepts
        // tool_choice "auto" or "none"; "required" fails every turn with a 400.
        // The engine already retries a turn that ends without a tool call.
        if (request.toolChoiceRequired) params.tool_choice = "auto";
        try {
          return await callModel(this.client as OpenAI, (turnClient) => streamChatCompletion(
            turnClient,
            params,
            request.callbacks,
            request.signal,
            request.eagerSettleStreaming,
          ));
        } catch (error) {
          throw error instanceof Error ? error : new Error(String(error));
        }
      },
      /* v8 ignore stop */
      /* v8 ignore start -- ping: tested via provider-ping.test.ts @preserve */
      async ping(signal?: AbortSignal): Promise<void> {
        await callModel(this.client as OpenAI, (turnClient) => turnClient.chat.completions.create(
          { model: this.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
          { signal },
        ))
      },
      /* v8 ignore stop */
      /* v8 ignore next 3 -- delegation: classification logic tested via classifyGithubCopilotError @preserve */
      classifyError(error: Error): ProviderErrorClassification {
        return classifyGithubCopilotError(error);
      },
    };
  }

  // Responses API path (GPT models via Copilot)
  let nativeInput: ResponseItem[] | null = null;
  let nativeInstructions = "";
  return {
    id: "github-copilot",
    model,
    client,
    capabilities,
    supportedReasoningEfforts: modelCaps.reasoningEffort,
    /* v8 ignore start -- responses path: tested via mock assertions in github-copilot.test.ts @preserve */
    resetTurnState(messages: OpenAI.ChatCompletionMessageParam[]): void {
      const { instructions, input } = toResponsesInput(messages);
      nativeInput = input;
      nativeInstructions = instructions;
    },
    appendToolOutput(callId: string, output: string): void {
      if (!nativeInput) return;
      nativeInput.push({ type: "function_call_output", call_id: callId, output: truncateResponsesFunctionCallOutput(output) });
    },
    async streamTurn(request: ProviderTurnRequest): Promise<TurnResult> {
      if (!nativeInput) this.resetTurnState(request.messages);
      const params: Record<string, unknown> = {
        model: this.model,
        input: nativeInput,
        instructions: nativeInstructions,
        tools: toResponsesTools(request.activeTools),
        reasoning: { effort: request.reasoningEffort ?? "medium", summary: "detailed" },
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
      };
      if (request.traceId) params.metadata = { trace_id: request.traceId };
      if (request.toolChoiceRequired) params.tool_choice = "required";
      try {
        const result = await callModel(this.client as OpenAI, (turnClient) => streamResponsesApi(
          turnClient,
          params,
          request.callbacks,
          request.signal,
          request.eagerSettleStreaming,
        ));
        for (const item of result.outputItems) nativeInput!.push(item);
        return result;
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
    /* v8 ignore stop */
    /* v8 ignore start -- ping: tested via provider-ping.test.ts @preserve */
    async ping(signal?: AbortSignal): Promise<void> {
      await callModel(this.client as OpenAI, (turnClient) => turnClient.responses.create(
        { model: this.model, input: "ping", max_output_tokens: 16 } as any,
        { signal },
      ))
    },
    /* v8 ignore stop */
    /* v8 ignore next 3 -- delegation: classification logic tested via classifyGithubCopilotError @preserve */
    classifyError(error: Error): ProviderErrorClassification {
      return classifyGithubCopilotError(error);
    },
  };
}
