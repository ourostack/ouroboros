import type { ToolDefinition } from "./tools-base"
import { emitNervesEvent } from "../nerves/runtime"

export const telegramContactToolDefinition: ToolDefinition = {
  tool: { type: "function", function: {
    name: "telegram_contact_manage",
    description: "List household Telegram contacts, revoke one exact approved contact, or release one exact blocked contact request. Owner only; quarantined message text is never returned.",
    parameters: { type: "object", properties: {
      action: { type: "string", enum: ["list", "revoke", "unblock"] },
      friendId: { type: "string", description: "Exact Friend ID from list; required for revoke." },
      admissionId: { type: "string", description: "Exact blocked admission ID from list; required for unblock." },
    }, required: ["action"], additionalProperties: false },
  } },
  handler: async (args, ctx) => {
    const actor = ctx?.relationshipAuthorization?.actor
    const manager = ctx?.telegramContactManager
    if (!actor || actor.trustLevel !== "family" || !manager) return JSON.stringify({ ok: false, error: "Telegram contact management requires the live owner relationship" })
    const action = String(args.action ?? "")
    if (action === "list") return JSON.stringify({ ok: true, ...(await manager.list({ actorFriendId: actor.friendId })) })
    if (action === "revoke" && typeof args.friendId === "string" && args.friendId.trim()) return JSON.stringify({ ok: true, ...(await manager.revoke({ actorFriendId: actor.friendId, friendId: args.friendId })) })
    if (action === "unblock" && typeof args.admissionId === "string" && args.admissionId.trim()) return JSON.stringify({ ok: true, ...(await manager.unblock({ actorFriendId: actor.friendId, admissionId: args.admissionId })) })
    return JSON.stringify({ ok: false, error: "Telegram contact management arguments are invalid" })
  },
  riskProfile: (args) => String(args.action) === "list" ? { mutates: "none", risk: "low" } : { mutates: "durable_state_write", risk: "high", reason: "changes one exact household Telegram admission" },
  approvalPolicy: () => ({ kind: "not_required" }),
}

emitNervesEvent({
  component: "repertoire",
  event: "repertoire.telegram_contact_tool_loaded",
  message: "Telegram contact management tool loaded",
  meta: { operations: 3 },
})
