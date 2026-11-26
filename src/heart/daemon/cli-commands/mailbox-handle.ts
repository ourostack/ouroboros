// `ouro mailbox handle set`, declared by hand outside the generated mailbox group, so it has a CLI door only: no MCP
// tool, in-turn tool or A2A door reaches it (design §3.4). Only the owner, at a shell, says whose messages answer.
import type { CliCommandDeclaration } from "../cli-manifest"
import { agentErrors, unknownFlag, usageError } from "./cards"

export const MAILBOX_HANDLE_COMMANDS: readonly CliCommandDeclaration[] = [
  {
    name: "mailbox handle set", effect: "private", summary: "Set the iMessage handle whose messages answer a person's letters.",
    example: "mailbox handle set friend-ari +15551234567 --agent slugger",
    ax: {
      id: "cli:mailbox handle set", group: "mailbox", effect: "write", idempotent: true,
      when: "Before letters can reach a person in chat: names the phone number or email address they answer from; letters filed afterwards use it.",
      errors: [
        usageError("mailbox handle set", "needs the person (a friend id or name) and the handle.", "Run it as ouro mailbox handle set <person> <handle>, the handle a phone number with its country code or an email address."),
        { code: "bad-handle", means: "The handle isn't an email address or a phone number with its country code.", fix: "Write the number with its country code, such as +15551234567, or give the email address the person uses for iMessage." },
        { code: "no-person", means: "No friend of this agent has that id or name.", fix: "Find the person's friend id with ouro friend list, then pass it." },
        { code: "which-person", means: "Several friends have that name.", fix: "Pass the person's friend id instead, from ouro friend list." },
        unknownFlag("mailbox handle set"),
        ...agentErrors("mailbox handle set"),
      ],
    },
  },
]
