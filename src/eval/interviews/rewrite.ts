/**
 * An arm's replacement list (pre-registration section 3, "Removing brand words"): every text the arm's harness, kit or
 * interface puts in front of the model is rewritten before the host's brand scan. That covers the system prompt, the
 * tools (names, descriptions and schemas), the messages and the tool results. Each arm commits its own list, in
 * order: whole sentences first (so "You are Codex, based on GPT-5" becomes "You are a coding agent"), then single
 * words. The host's scan still runs on the rewritten request and voids anything the list missed.
 *
 * Only what the model is sent is rewritten. The harness keeps its own request, so a tool the list renames is still
 * called by its own name: `toolName` maps the model's name back.
 */
import type { ProviderTurnRequest } from "../../heart/core"

/** One replacement; the pattern must be global, so every match is replaced, not only the first. */
export type Replacement = { pattern: RegExp; with: string }

/** Applies the list in order to one text. */
export function replace(text: string, list: readonly Replacement[]): string {
  return list.reduce((out, { pattern, with: by }) => {
    if (!pattern.global) throw new Error(`replacement ${String(pattern)} must be global (the g flag)`)
    return out.replace(pattern, by)
  }, text)
}

/** Every string in a plain value rewritten; anything else as it is. */
function deep<T>(value: T, list: readonly Replacement[]): T {
  if (typeof value === "string") return replace(value, list) as T
  if (Array.isArray(value)) return value.map((item: unknown) => deep(item, list)) as T
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item, list)])) as T
  return value
}

/**
 * The request as the model is sent it, and the harness's own name for each tool the model may call by its rewritten
 * name. The harness's fields (callbacks, signal, trace id) are passed through untouched.
 */
export function rewriteRequest(request: ProviderTurnRequest, list: readonly Replacement[]): { request: ProviderTurnRequest; toolName(name: string): string } {
  const rewritten: ProviderTurnRequest = {
    ...request,
    messages: deep(request.messages, list),
    activeTools: deep(request.activeTools, list),
    ...(request.deferredTools ? { deferredTools: deep(request.deferredTools, list) } : {}),
    ...(request.systemPrompt ? { systemPrompt: deep(request.systemPrompt, list) } : {}),
  }
  const back = new Map<string, string>()
  for (const tool of [...request.activeTools, ...request.deferredTools ?? []]) {
    const own = tool.function.name
    const sent = replace(own, list)
    const earlier = back.get(sent)
    if (earlier !== undefined && earlier !== own) throw new Error(`tools ${earlier} and ${own} would both be called ${sent}`)
    back.set(sent, own)
  }
  return { request: rewritten, toolName: (name) => back.get(name) ?? name }
}
