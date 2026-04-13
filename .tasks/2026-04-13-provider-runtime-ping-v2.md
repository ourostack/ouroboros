# Doing: Add ping() to ProviderRuntime (re-ship + azure fix)

**Branch**: ouroboros/provider-runtime-ping-v2
**Base**: main

## Context
PR #465 squash-merged incorrectly — only the test mock fix landed, not the actual refactor. The production code still has the old if/else routing chain in `pingProvider()`. Additionally, Azure's ping needs to use the Responses API to match its runtime (currently uses chat completions with `max_tokens` which will break when Azure deploys models that reject it).

## Unit 1: Add ping() to ProviderRuntime and all providers, simplify pingProvider

### Changes

**`src/heart/core.ts`** — Add to `ProviderRuntime` interface (after line 69):
```typescript
  /** Minimal API call to verify credentials work. Throws on failure. */
  ping(signal?: AbortSignal): Promise<void>;
```

**`src/heart/providers/anthropic.ts`** — Add `ping` to the returned runtime object (before `classifyError`). Use haiku model and the beta header to exclude thinking:
```typescript
    /* v8 ignore start -- ping: tested via provider-ping.test.ts @preserve */
    async ping(signal?: AbortSignal): Promise<void> {
      await (this.client as Anthropic).messages.create(
        { model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
        { signal, headers: { "anthropic-beta": "claude-code-20250219,oauth-2025-04-20" } },
      )
    },
    /* v8 ignore stop */
```
Need to add `import type Anthropic from "@anthropic-ai/sdk"` at the top if not already there.

**`src/heart/providers/azure.ts`** — Add `ping` using Responses API (matching runtime):
```typescript
    /* v8 ignore start -- ping: tested via provider-ping.test.ts @preserve */
    async ping(signal?: AbortSignal): Promise<void> {
      await (this.client as OpenAI).responses.create(
        { model: this.model, input: "ping", max_output_tokens: 16 } as any,
        { signal },
      )
    },
    /* v8 ignore stop */
```

**`src/heart/providers/minimax.ts`** — Add `ping` using chat completions (matching runtime):
```typescript
    /* v8 ignore start -- ping: tested via provider-ping.test.ts @preserve */
    async ping(signal?: AbortSignal): Promise<void> {
      await (this.client as OpenAI).chat.completions.create(
        { model: this.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
        { signal },
      )
    },
    /* v8 ignore stop */
```

**`src/heart/providers/openai-codex.ts`** — Add `ping` using Responses API (matching runtime):
```typescript
    /* v8 ignore start -- ping: tested via provider-ping.test.ts @preserve */
    async ping(signal?: AbortSignal): Promise<void> {
      await (this.client as OpenAI).responses.create(
        { model: this.model, input: "ping", max_output_tokens: 16 } as any,
        { signal },
      )
    },
    /* v8 ignore stop */
```

**`src/heart/providers/github-copilot.ts`** — Add `ping` to BOTH returns:

Chat completions path (Claude models, before `classifyError`):
```typescript
    /* v8 ignore start -- ping: tested via provider-ping.test.ts @preserve */
    async ping(signal?: AbortSignal): Promise<void> {
      await (this.client as OpenAI).chat.completions.create(
        { model: this.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
        { signal },
      )
    },
    /* v8 ignore stop */
```

Responses path (GPT models, before `classifyError`):
```typescript
    /* v8 ignore start -- ping: tested via provider-ping.test.ts @preserve */
    async ping(signal?: AbortSignal): Promise<void> {
      await (this.client as OpenAI).responses.create(
        { model: this.model, input: "ping", max_output_tokens: 16 } as any,
        { signal },
      )
    },
    /* v8 ignore stop */
```

**`src/heart/provider-ping.ts`** — Replace the entire if/else chain in `pingProvider`'s run block (lines ~254-283) with:
```typescript
        await runtime.ping(controller.signal)
```

Then clean up unused imports and constants:
- Remove `import type Anthropic from "@anthropic-ai/sdk"` (line 1)
- Remove `import OpenAI from "openai"` (line 2)
- Remove `type ChannelCallbacks` from import (line 3)
- Remove `PING_CALLBACKS` constant
- Remove `ANTHROPIC_SETUP_PING_MODEL` constant
- Keep `createChatPingRequest`, `createPingMessages`, `PING_PROMPT`, `CHAT_PING_MAX_TOKENS`, `createResponsePingRequest`, `RESPONSE_PING_MAX_OUTPUT_TOKENS` — they're still used by `pingGithubCopilotModel`

**`src/__tests__/heart/provider-ping.test.ts`** — The test mocks already have `ping` methods from PR #465's squash merge. They should work as-is with the new production code. Verify by running tests.

Also check if `Anthropic` type import is needed in `anthropic.ts`. Read the file's existing imports first.

### Test
```bash
npx vitest run src/__tests__/heart/provider-ping.test.ts && npx tsc --noEmit
```

### Commit
`refactor(heart): add ping() to ProviderRuntime, fix azure ping to use Responses API`
