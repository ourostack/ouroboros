import OpenAI, { AzureOpenAI } from "openai";
import { getAzureConfig } from "../config";
import { emitNervesEvent } from "../../nerves/runtime";
import type { ProviderCapability, ProviderRuntime, ProviderTurnRequest } from "../core";
import type { ResponseItem, TurnResult } from "../streaming";
import { streamResponsesApi, toResponsesInput, toResponsesTools } from "../streaming";
import { getModelCapabilities } from "../model-capabilities";

const COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default";

// @azure/identity is imported dynamically (below) rather than at the top level
// because it's a heavy package (~30+ transitive deps) and we only need it when
// using the managed-identity auth path. API-key users and other providers
// shouldn't pay the cold-start cost.
export function createAzureTokenProvider(managedIdentityClientId?: string): () => Promise<string> {
  let credential: { getToken(scope: string): Promise<{ token: string }> } | null = null;

  return async (): Promise<string> => {
    try {
      if (!credential) {
        const { DefaultAzureCredential } = await import("@azure/identity");
        const credentialOptions = managedIdentityClientId
          ? { managedIdentityClientId }
          : undefined;
        credential = new DefaultAzureCredential(credentialOptions);
      }
      const tokenResponse = await credential.getToken(COGNITIVE_SERVICES_SCOPE);
      return tokenResponse.token;
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Azure OpenAI authentication failed: ${detail}\n` +
        "To fix this, either:\n" +
        "  1. Set providers.azure.apiKey in secrets.json, or\n" +
        "  2. Run 'az login' to authenticate with your Azure account (for local dev), or\n" +
        "  3. Attach a managed identity to your App Service and set providers.azure.managedIdentityClientId in secrets.json (for deployed environments)",
      );
    }
  };
}

export function createAzureProviderRuntime(): ProviderRuntime {
  const azureConfig = getAzureConfig();
  const useApiKey = !!azureConfig.apiKey;
  const authMethod = useApiKey ? "key" : "managed-identity";

  emitNervesEvent({
    component: "engine",
    event: "engine.provider_init",
    message: "azure provider init",
    meta: { provider: "azure", authMethod },
  });

  if (!(azureConfig.endpoint && azureConfig.deployment && azureConfig.modelName)) {
    throw new Error(
      "provider 'azure' is selected in agent.json but providers.azure is incomplete in secrets.json.",
    );
  }
  const modelCaps = getModelCapabilities(azureConfig.modelName);
  const capabilities = new Set<ProviderCapability>();
  if (modelCaps.reasoningEffort) capabilities.add("reasoning-effort");

  const clientOptions: Record<string, unknown> = {
    endpoint: azureConfig.endpoint.replace(/\/openai.*$/, ""),
    deployment: azureConfig.deployment,
    apiVersion: azureConfig.apiVersion,
    timeout: 30000,
    maxRetries: 0,
  };

  if (useApiKey) {
    clientOptions.apiKey = azureConfig.apiKey;
  } else {
    const managedIdentityClientId = azureConfig.managedIdentityClientId || undefined;
    clientOptions.azureADTokenProvider = createAzureTokenProvider(managedIdentityClientId);
  }

  const client = new AzureOpenAI(clientOptions as ConstructorParameters<typeof AzureOpenAI>[0]);
  let nativeInput: ResponseItem[] | null = null;
  let nativeInstructions = "";
  return {
    id: "azure",
    model: azureConfig.modelName,
    client,
    capabilities,
    supportedReasoningEfforts: modelCaps.reasoningEffort,
    resetTurnState(messages: OpenAI.ChatCompletionMessageParam[]): void {
      const { instructions, input } = toResponsesInput(messages);
      nativeInput = input;
      nativeInstructions = instructions;
    },
    appendToolOutput(callId: string, output: string): void {
      if (!nativeInput) return;
      nativeInput.push({ type: "function_call_output", call_id: callId, output });
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
      const result = await streamResponsesApi(
        this.client as OpenAI,
        params,
        request.callbacks,
        request.signal,
        request.eagerFinalAnswerStreaming,
      );
      for (const item of result.outputItems) nativeInput!.push(item);
      return result;
    },
  };
}
