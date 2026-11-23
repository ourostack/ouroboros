import type { ToolDefinition } from "./tools-base"
import { emitNervesEvent } from "../nerves/runtime"

export const telegramContactToolDefinition: ToolDefinition = {
  tool: { type: "function", function: {
    name: "telegram_contact_manage",
    description: "List household Telegram contacts, revoke one exact approved contact, or release one exact blocked contact request. Owner only; the result leaves out quarantined message text.",
    parameters: { type: "object", properties: {
      action: { type: "string", enum: ["list", "revoke", "unblock"] },
      friendId: { type: "string", description: "Exact Friend ID from list; required for revoke." },
      admissionId: { type: "string", description: "Exact blocked admission ID from list; required for unblock." },
    }, required: ["action"], additionalProperties: false },
  } },
  handler: async (args, ctx) => {
    const actor = ctx?.relationshipAuthorization?.actor
    const manager = ctx?.telegramContactManager
    if (!actor || actor.trustLevel !== "family" || !manager) return JSON.stringify({ ok: false, error: "Telegram contact management requires the live owner relationship", code: "owner-only" })
    const action = String(args.action ?? "")
    if (action === "list") return JSON.stringify({ ok: true, ...(await manager.list({ actorFriendId: actor.friendId })) })
    if (action === "revoke" && typeof args.friendId === "string" && args.friendId.trim()) return JSON.stringify({ ok: true, ...(await manager.revoke({ actorFriendId: actor.friendId, friendId: args.friendId })) })
    if (action === "unblock" && typeof args.admissionId === "string" && args.admissionId.trim()) return JSON.stringify({ ok: true, ...(await manager.unblock({ actorFriendId: actor.friendId, admissionId: args.admissionId })) })
    return JSON.stringify({ ok: false, error: "Telegram contact management arguments are invalid", code: "invalid-contact-request" })
  },
  ax: { id: "tool:telegram_contact_manage", group: "friends", when: "Pick this when your owner asks who may message you on Telegram, wants an approved person cut off, or lets a held-back request through.", effect: "write", destructive: true, errors: [
    { code: "owner-only", means: "This turn has no live owner relationship in my Telegram chat: either the person isn't the owner, or this isn't that chat.", fix: "Tell them the owner can make this change from their Telegram chat with me." },
    { code: "invalid-contact-request", means: "revoke came without friendId, or unblock without admissionId, or the id was blank.", fix: "Call with action list first, then pass the exact friendId or admissionId it shows." },
  ] },
  riskProfile: (args) => String(args.action) === "list" ? { mutates: "none", risk: "low" } : { mutates: "durable_state_write", risk: "high", reason: "changes one exact household Telegram admission" },
  approvalPolicy: () => ({ kind: "not_required" }),
}

emitNervesEvent({
  component: "repertoire",
  event: "repertoire.telegram_contact_tool_loaded",
  message: "Telegram contact management tool loaded",
  meta: { operations: 3 },
})
