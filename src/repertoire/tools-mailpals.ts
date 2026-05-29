import type OpenAI from "openai"
import { emitNervesEvent } from "../nerves/runtime"
import type { ToolDefinition } from "./tools-base"
import {
  createNextIssue,
  openIssue,
  recordAnswer,
  compileAndDeliver,
  skipIssue,
  pauseGroup,
  resumeGroup,
  getStatus,
  parseDay,
  parseTime,
} from "../mailpals/lifecycle"
import {
  createGroup,
  createMember,
  readGroup,
  readMember,
  readOpenIssue,
  writeGroup,
} from "../mailpals/store"
import { compiledIssueToMessages } from "../mailpals/delivery"

function getMailPalsStateRoot(ctx?: { agentRoot?: string }): string {
  const agentRoot = ctx?.agentRoot
  if (!agentRoot) throw new Error("agentRoot not available — mailpals tools require a bundle context")
  return `${agentRoot}/state/mailpals`
}

export const mailpalsToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "mailpals_create_group",
        description:
          "create a new mailpals group. members answer weekly prompts via DM, then answers are compiled and delivered to the group chat.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "group name" },
            groupChatId: { type: "string", description: "BlueBubbles group chat GUID to deliver compiled issues to" },
          },
          required: ["title"],
        },
      },
    } satisfies OpenAI.ChatCompletionFunctionTool,
    handler: (args, ctx) => {
      const stateRoot = getMailPalsStateRoot(ctx)
      const group = createGroup(stateRoot, {
        title: args.title,
        promptsPerIssue: 3,
        promptDay: 0,
        promptTime: "09:00",
        deliveryDay: 4,
        deliveryTime: "09:00",
        timezone: "America/New_York",
        paused: false,
        groupChatId: args.groupChatId || null,
        memberIds: [],
      })
      emitNervesEvent({
        component: "mailpals",
        event: "mailpals.group_created",
        message: `created group "${group.title}"`,
        meta: { groupId: group.id },
      })
      return `created group "${group.title}" (id: ${group.id})`
    },
    summaryKeys: ["title"],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "creates a new mailpals group" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "mailpals_add_member",
        description: "add a member to a mailpals group. requires their friend id from the friends system.",
        parameters: {
          type: "object",
          properties: {
            groupId: { type: "string", description: "mailpals group id" },
            friendId: { type: "string", description: "friend record id from the friends system" },
            displayName: { type: "string", description: "how this person should be displayed in the group" },
            role: { type: "string", enum: ["member", "admin"], description: "member role (default: member)" },
          },
          required: ["groupId", "friendId", "displayName"],
        },
      },
    } satisfies OpenAI.ChatCompletionFunctionTool,
    handler: (args, ctx) => {
      const stateRoot = getMailPalsStateRoot(ctx)
      const group = readGroup(stateRoot, args.groupId)
      if (!group) return `group ${args.groupId} not found`
      const member = createMember(stateRoot, {
        groupId: args.groupId,
        friendId: args.friendId,
        displayName: args.displayName,
        role: (args.role as "member" | "admin") || "member",
        active: true,
      })
      group.memberIds = [...group.memberIds, member.id]
      writeGroup(stateRoot, group)
      emitNervesEvent({
        component: "mailpals",
        event: "mailpals.member_added",
        message: `added ${member.displayName} to group ${group.title}`,
        meta: { groupId: group.id, memberId: member.id },
      })
      return `added ${member.displayName} to "${group.title}" (member id: ${member.id})`
    },
    summaryKeys: ["groupId", "displayName"],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "adds a member to a mailpals group" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "mailpals_set_schedule",
        description: "change the prompt or delivery schedule for a mailpals group.",
        parameters: {
          type: "object",
          properties: {
            groupId: { type: "string", description: "mailpals group id" },
            which: { type: "string", enum: ["prompt", "delivery"], description: "which schedule to change" },
            day: { type: "string", description: "day of week (e.g. monday, wed, friday)" },
            time: { type: "string", description: "time (e.g. 10am, 9:30pm, 14:00)" },
          },
          required: ["groupId", "which", "day", "time"],
        },
      },
    } satisfies OpenAI.ChatCompletionFunctionTool,
    handler: (args, ctx) => {
      const stateRoot = getMailPalsStateRoot(ctx)
      const group = readGroup(stateRoot, args.groupId)
      if (!group) return `group ${args.groupId} not found`

      const day = parseDay(args.day)
      if (day === null) return `don't recognize "${args.day}" as a day`

      const time = parseTime(args.time)
      if (time === null) return `can't parse "${args.time}" — try something like 9am or 14:00`

      const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
      if (args.which === "prompt") {
        group.promptDay = day
        group.promptTime = time
      } else {
        group.deliveryDay = day
        group.deliveryTime = time
      }
      writeGroup(stateRoot, group)

      const label = args.which === "prompt" ? "prompts" : "delivery"
      emitNervesEvent({
        component: "mailpals",
        event: "mailpals.schedule_updated",
        message: `updated ${label} schedule to ${days[day]} ${time}`,
        meta: { groupId: group.id, which: args.which },
      })
      return `${label}: ${days[day]} ${time}`
    },
    summaryKeys: ["groupId", "which", "day", "time"],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "changes mailpals group schedule" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "mailpals_open_issue",
        description:
          "manually open a new issue for a mailpals group. creates the issue, opens it, and returns the DM messages to send to each member.",
        parameters: {
          type: "object",
          properties: {
            groupId: { type: "string", description: "mailpals group id" },
          },
          required: ["groupId"],
        },
      },
    } satisfies OpenAI.ChatCompletionFunctionTool,
    handler: (args, ctx) => {
      const stateRoot = getMailPalsStateRoot(ctx)
      const deps = { stateRoot }
      const issue = createNextIssue(deps, args.groupId)
      if (!issue) return "group is paused — resume it first"
      const result = openIssue(deps, issue.id, issue)
      const summary = result.memberMessages.map((m) => `DM ${m.friendId}: ${m.text.slice(0, 80)}...`).join("\n")
      return `opened issue #${issue.number} with ${issue.prompts.length} prompts.\n\nMessages to send:\n${summary}`
    },
    summaryKeys: ["groupId"],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "opens a new mailpals issue and queues DMs" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "mailpals_record_answer",
        description:
          "record a member's answer to the current mailpals prompt. call this when a member's message is an answer to an open mailpals prompt (check the per-turn context for 'owes X/Y').",
        parameters: {
          type: "object",
          properties: {
            memberId: { type: "string", description: "mailpals member id" },
            text: { type: "string", description: "the member's answer text" },
          },
          required: ["memberId", "text"],
        },
      },
    } satisfies OpenAI.ChatCompletionFunctionTool,
    handler: (args, ctx) => {
      const stateRoot = getMailPalsStateRoot(ctx)
      const deps = { stateRoot }
      // Find the open issue for this member's group
      const member = readMember(stateRoot, args.memberId)
      if (!member) return `member ${args.memberId} not found`
      const issue = readOpenIssue(stateRoot, member.groupId)
      if (!issue) return "no active prompt right now. sit tight"
      const result = recordAnswer(deps, issue.id, args.memberId, args.text)
      return result.nextMessage ?? "answer recorded"
    },
    summaryKeys: ["memberId"],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "records a mailpals answer" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "mailpals_status",
        description: "get the current status of a mailpals group.",
        parameters: {
          type: "object",
          properties: {
            groupId: { type: "string", description: "mailpals group id" },
          },
          required: ["groupId"],
        },
      },
    } satisfies OpenAI.ChatCompletionFunctionTool,
    handler: (args, ctx) => {
      const stateRoot = getMailPalsStateRoot(ctx)
      return getStatus({ stateRoot }, args.groupId)
    },
    summaryKeys: ["groupId"],
    riskProfile: { mutates: "none", risk: "low" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "mailpals_skip",
        description: "skip the current mailpals issue for a group.",
        parameters: {
          type: "object",
          properties: {
            groupId: { type: "string", description: "mailpals group id" },
          },
          required: ["groupId"],
        },
      },
    } satisfies OpenAI.ChatCompletionFunctionTool,
    handler: (args, ctx) => {
      const stateRoot = getMailPalsStateRoot(ctx)
      return skipIssue({ stateRoot }, args.groupId)
    },
    summaryKeys: ["groupId"],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "skips a mailpals issue" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "mailpals_pause",
        description: "pause a mailpals group. no new issues will be created until resumed.",
        parameters: {
          type: "object",
          properties: {
            groupId: { type: "string", description: "mailpals group id" },
          },
          required: ["groupId"],
        },
      },
    } satisfies OpenAI.ChatCompletionFunctionTool,
    handler: (args, ctx) => {
      const stateRoot = getMailPalsStateRoot(ctx)
      return pauseGroup({ stateRoot }, args.groupId)
    },
    summaryKeys: ["groupId"],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "pauses a mailpals group" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "mailpals_resume",
        description: "resume a paused mailpals group and schedule the next issue.",
        parameters: {
          type: "object",
          properties: {
            groupId: { type: "string", description: "mailpals group id" },
          },
          required: ["groupId"],
        },
      },
    } satisfies OpenAI.ChatCompletionFunctionTool,
    handler: (args, ctx) => {
      const stateRoot = getMailPalsStateRoot(ctx)
      return resumeGroup({ stateRoot }, args.groupId)
    },
    summaryKeys: ["groupId"],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "resumes a paused mailpals group" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "mailpals_deliver",
        description: "compile and deliver the current mailpals issue to the group chat. returns the compiled messages.",
        parameters: {
          type: "object",
          properties: {
            groupId: { type: "string", description: "mailpals group id" },
          },
          required: ["groupId"],
        },
      },
    } satisfies OpenAI.ChatCompletionFunctionTool,
    handler: (args, ctx) => {
      const stateRoot = getMailPalsStateRoot(ctx)
      const issue = readOpenIssue(stateRoot, args.groupId)
      if (!issue) return "no open issue to deliver"
      const result = compileAndDeliver({ stateRoot }, issue.id)
      const messages = compiledIssueToMessages(result.compiled)
      return `compiled issue #${result.compiled.issueNumber}. ${messages.length} messages to send to group chat${result.groupChatId ? ` (${result.groupChatId})` : ""}:\n\n${messages.map((m) => m.text).join("\n---\n")}`
    },
    summaryKeys: ["groupId"],
    riskProfile: { mutates: ["durable_state_write", "external_side_effect"], risk: "high", reason: "compiles and delivers a mailpals issue" },
  },
]
