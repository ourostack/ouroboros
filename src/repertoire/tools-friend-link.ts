import type { Channel } from "@ouro.bot/friends"
import type { ToolDefinition } from "./tools-base"
import { getAgentRoot } from "../heart/identity"
import { issueLinkCode } from "../mind/friend-link-codes"
import { emitNervesEvent } from "../nerves/runtime"

const LINKABLE_CHANNELS: readonly Channel[] = ["teams", "bluebubbles", "telegram", "mail", "voice", "mcp", "cli"]

export const friendLinkToolDefinition: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "friend_link_code",
      description:
        "Issue a one-time code that links another account of the person you are talking to (for example their Teams account) to them. " +
        "Give them the code; when they send exactly that code to you from the other account in a 1:1 chat, that account is treated as them. " +
        "Only for family, only for themselves, and never in a group chat. The code expires in 10 minutes and works once.",
      parameters: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            enum: [...LINKABLE_CHANNELS],
            description: "The channel the other account will message from. Omit to accept any channel.",
          },
        },
      },
    },
  },
  handler: async (args, ctx) => {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.tool_friend_link_code",
      message: "friend_link_code invoked",
      meta: { channel: args.channel ?? "any" },
    })
    const context = ctx?.context
    if (!context?.friend) return "no friend context: I can only issue a link code to the person I'm talking to."
    const friend = context.friend
    if (friend.trustLevel !== "family") return "link codes are only for family."
    if (context.isGroupChat) return "link codes can't be issued in a group chat. Ask me in a 1:1 chat."
    const channel = args.channel
    if (channel && !(LINKABLE_CHANNELS as readonly string[]).includes(channel)) return `unknown channel '${channel}'. Use one of: ${LINKABLE_CHANNELS.join(", ")}.`
    const issued = issueLinkCode({
      agentRoot: ctx?.agentRoot ?? getAgentRoot(),
      friend,
      ...(channel ? { channel: channel as Channel } : {}),
      issuedBy: `tool:${context.channel.channel}`,
    })
    const where = issued.channel ? `from their ${issued.channel} account` : "from the account they want to link"
    return `link code for ${friend.name}: ${issued.code}\nTell them to send exactly this code to me ${where}, in a 1:1 chat, before ${issued.expiresAt}. It works once.`
  },
  summaryKeys: ["channel"],
  riskProfile: { mutates: "durable_state_write", risk: "high", reason: "issues a code that links a new account to a family friend" },
}
