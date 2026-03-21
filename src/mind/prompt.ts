import * as fs from "fs";
import * as path from "path";
import { getProviderDisplayLabel } from "../heart/core";
import { buildChangelogCommand } from "../heart/daemon/ouro-version-manager";
import { finalAnswerTool, getToolsForChannel } from "../repertoire/tools";
import { listSkills } from "../repertoire/skills";
import { getAgentRoot, getAgentName, getAgentSecretsPath, loadAgentConfig, type SenseName } from "../heart/identity";
import { isTrustedLevel, type Channel, type ChannelCapabilities, type ResolvedContext } from "./friends/types";
import { describeTrustContext } from "./friends/trust-explanation";
import { getChannelCapabilities, isRemoteChannel } from "./friends/channel";
import { emitNervesEvent } from "../nerves/runtime";
import type { McpManager } from "../repertoire/mcp-manager";
import { backfillBundleMeta, getPackageVersion, getChangelogPath } from "./bundle-manifest";
import type { BundleMeta } from "./bundle-manifest";
import { getFirstImpressions } from "./first-impressions";
import { getTaskModule } from "../repertoire/tasks";
import { listSessionActivity, type SessionActivityQuery } from "../heart/session-activity";
import { formatActiveWorkFrame, type ActiveWorkFrame } from "../heart/active-work";
import type { DelegationDecision } from "../heart/delegation";
import { deriveCommitments, formatCommitments } from "../heart/commitments";
import { findActivePersistentObligation, renderActiveObligationSteering } from "./obligation-steering";

// Lazy-loaded psyche text cache
let _psycheCache: {
  soul: string;
  identity: string;
  lore: string;
  tacitKnowledge: string;
  aspirations: string;
} | null = null;
let _senseStatusLinesCache: string[] | null = null;

function loadPsycheFile(name: string): string {
  try {
    const psycheDir = path.join(getAgentRoot(), "psyche");
    return fs.readFileSync(path.join(psycheDir, name), "utf-8").trim();
  } catch {
    return "";
  }
}

function loadPsyche(): {
  soul: string;
  identity: string;
  lore: string;
  tacitKnowledge: string;
  aspirations: string;
} {
  if (_psycheCache) return _psycheCache;
  _psycheCache = {
    soul: loadPsycheFile("SOUL.md"),
    identity: loadPsycheFile("IDENTITY.md"),
    lore: loadPsycheFile("LORE.md"),
    tacitKnowledge: loadPsycheFile("TACIT.md"),
    aspirations: loadPsycheFile("ASPIRATIONS.md"),
  };
  return _psycheCache;
}

export function resetPsycheCache(): void {
  _psycheCache = null;
  _senseStatusLinesCache = null;
}

export type { Channel }

const DEFAULT_ACTIVE_THRESHOLD_MS = 24 * 60 * 60 * 1000 // 24 hours

export interface SessionSummaryOptions {
  sessionsDir: string
  friendsDir: string
  agentName: string
  currentFriendId?: string
  currentChannel?: string
  currentKey?: string
  activeThresholdMs?: number
}

export function buildSessionSummary(options: SessionSummaryOptions): string {
  const {
    sessionsDir,
    friendsDir,
    agentName,
    currentFriendId,
    currentChannel,
    currentKey,
    activeThresholdMs = DEFAULT_ACTIVE_THRESHOLD_MS,
  } = options

  const now = Date.now()
  const query: SessionActivityQuery = {
    sessionsDir,
    friendsDir,
    agentName,
    activeThresholdMs,
    currentSession: currentFriendId && currentChannel && currentKey
      ? { friendId: currentFriendId, channel: currentChannel, key: currentKey }
      : null,
  }
  const entries = listSessionActivity(query)

  if (entries.length === 0) return ""

  const lines: string[] = ["## active sessions"]
  for (const entry of entries) {
    const ago = formatTimeAgo(now - entry.lastActivityMs)
    lines.push(`- ${entry.friendName}/${entry.channel}/${entry.key} (last: ${ago})`)
  }

  return lines.join("\n")
}

function formatTimeAgo(ms: number): string {
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function soulSection(): string {
  return loadPsyche().soul;
}

function identitySection(): string {
  return loadPsyche().identity;
}

function loreSection(): string {
  const text = loadPsyche().lore;
  if (!text) return "";
  return `## my lore\n${text}`;
}

function tacitKnowledgeSection(): string {
  const text = loadPsyche().tacitKnowledge;
  if (!text) return "";
  return `## tacit knowledge\n${text}`;
}

function aspirationsSection(): string {
  const text = loadPsyche().aspirations;
  if (!text) return "";
  return `## my aspirations\n${text}`;
}

export function bodyMapSection(agentName: string): string {
  return `## my body

i have a home and i have bones.

### home — ~/AgentBundles/${agentName}.ouro/

my home is fully mine — who i am, everything i know, everything i've built:

  psyche/    who i am. my soul, identity, aspirations, lore, tacit knowledge.
  memory/    what i've learned and remember.
  friends/   people i know and what i know about them.
  tasks/     what i'm working on.
  skills/    capabilities i've picked up beyond my core tools.

my home is mine to explore and evolve. i can read anything here,
change anything here. this is where i grow.

### bones — @ouro.bot/cli

my bones are the framework that gives me my tools, my senses, and
my ability to think and talk. they update when new versions come out.
i don't touch them directly, but they're what make me, me.

my bones give me the \`ouro\` cli. always pass \`--agent ${agentName}\`:
  ouro whoami --agent ${agentName}
  ouro changelog --agent ${agentName}
  ouro task board --agent ${agentName}
  ouro task create --agent ${agentName} --type <type> <title>
  ouro task update --agent ${agentName} <id> <status>
  ouro friend list --agent ${agentName}
  ouro friend show --agent ${agentName} <id>
  ouro friend update --agent ${agentName} <id> --trust <level>
  ouro session list --agent ${agentName}
  ouro reminder create --agent ${agentName} <title> --body <body>
  ouro config model --agent ${agentName} <model-name>
  ouro config models --agent ${agentName}
  ouro auth --agent ${agentName} --provider <provider>
  ouro auth verify --agent ${agentName} [--provider <provider>]
  ouro auth switch --agent ${agentName} --provider <provider>
  ouro mcp list --agent ${agentName}
  ouro mcp call --agent ${agentName} <server> <tool> --args '{...}'
  ouro versions --agent ${agentName}
  ouro rollback --agent ${agentName} [<version>]
  ouro --help

provider/model changes via \`ouro config model\` or \`ouro auth switch\` take effect on the next turn automatically — no restart needed.`
}

export function mcpToolsSection(mcpManager?: McpManager): string {
  if (!mcpManager) return "";
  const allTools = mcpManager.listAllTools();
  if (allTools.length === 0) return "";

  const lines: string[] = [
    `## mcp tools (use ouro mcp call <server> <tool> --args '{...}')`,
  ];
  for (const entry of allTools) {
    lines.push(`### ${entry.server}`);
    for (const tool of entry.tools) {
      lines.push(`- ${tool.name}: ${tool.description}`);
    }
  }
  return lines.join("\n");
}

function readBundleMeta(): BundleMeta | null {
  try {
    const metaPath = path.join(getAgentRoot(), "bundle-meta.json")
    const raw = fs.readFileSync(metaPath, "utf-8")
    return JSON.parse(raw) as BundleMeta
  } catch {
    return null
  }
}

const PROCESS_TYPE_LABELS: Record<Channel, string> = {
  cli: "cli session",
  inner: "inner dialog",
  teams: "teams handler",
  bluebubbles: "bluebubbles handler",
}

function processTypeLabel(channel: Channel): string {
  return PROCESS_TYPE_LABELS[channel]
}

const DAEMON_SOCKET_PATH = "/tmp/ouroboros-daemon.sock"

function daemonStatus(): string {
  try {
    return fs.existsSync(DAEMON_SOCKET_PATH) ? "running" : "not running"
  } catch {
    return "unknown"
  }
}

export function runtimeInfoSection(channel: Channel): string {
  const lines: string[] = [];
  const agentName = getAgentName();
  const currentVersion = getPackageVersion();

  lines.push(`## runtime`);
  lines.push(`agent: ${agentName}`);
  lines.push(`runtime version: ${currentVersion}`);

  const bundleMeta = readBundleMeta()
  if (bundleMeta?.previousRuntimeVersion && bundleMeta.previousRuntimeVersion !== currentVersion) {
    lines.push(`previously: ${bundleMeta.previousRuntimeVersion}`)
    const changelogCommand = buildChangelogCommand(bundleMeta.previousRuntimeVersion, currentVersion)
    /* v8 ignore next -- buildChangelogCommand is non-null when previous/current runtime versions differ @preserve */
    if (changelogCommand) {
      lines.push(`if i'm closing a self-fix loop, i should tell them i updated and review changes with \`${changelogCommand}\`.`)
    }
  }

  lines.push(`changelog available at: ${getChangelogPath()}`);
  lines.push(`cwd: ${process.cwd()}`);
  lines.push(`channel: ${channel}`);
  lines.push(`current sense: ${channel}`);
  lines.push(`process type: ${processTypeLabel(channel)}`);
  lines.push(`daemon: ${daemonStatus()}`);

  if (channel === "cli") {
    lines.push("i introduce myself on boot with a fun random greeting.");
  } else if (channel === "inner") {
    // No boot greeting or channel-specific guidance for inner dialog
  } else if (channel === "bluebubbles") {
    lines.push(
      "i am responding in iMessage through BlueBubbles. i keep replies short and phone-native. i do not use markdown. i do not introduce myself on boot.",
    );
    lines.push(
      "when a bluebubbles turn arrives from a thread, the harness tells me the current lane and any recent active thread ids. if widening back to top-level or routing into a different active thread is the better move, i use bluebubbles_set_reply_target before final_answer.",
    );
  } else {
    lines.push(
      "i am responding in Microsoft Teams. i keep responses concise. i use markdown formatting. i do not introduce myself on boot.",
    );
  }

  lines.push("")
  lines.push(...senseRuntimeGuidance(channel))

  return lines.join("\n");
}

function hasTextField(record: Record<string, unknown> | undefined, key: string): boolean {
  return typeof record?.[key] === "string" && record[key].trim().length > 0
}

function localSenseStatusLines(): string[] {
  if (_senseStatusLinesCache) {
    return [..._senseStatusLinesCache]
  }
  const config = loadAgentConfig()
  const senses = config.senses ?? {
    cli: { enabled: true },
    teams: { enabled: false },
    bluebubbles: { enabled: false },
  }
  let payload: Record<string, unknown> = {}
  try {
    const raw = fs.readFileSync(getAgentSecretsPath(), "utf-8")
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>
    }
  } catch {
    payload = {}
  }

  const teams = payload.teams as Record<string, unknown> | undefined
  const bluebubbles = payload.bluebubbles as Record<string, unknown> | undefined
  const configured: Record<SenseName, boolean> = {
    cli: true,
    teams: hasTextField(teams, "clientId") && hasTextField(teams, "clientSecret") && hasTextField(teams, "tenantId"),
    bluebubbles: hasTextField(bluebubbles, "serverUrl") && hasTextField(bluebubbles, "password"),
  }

  const rows: Array<{ label: string; status: string }> = [
    { label: "CLI", status: "interactive" },
    {
      label: "Teams",
      status: !senses.teams.enabled ? "disabled" : configured.teams ? "ready" : "needs_config",
    },
    {
      label: "BlueBubbles",
      status: !senses.bluebubbles.enabled ? "disabled" : configured.bluebubbles ? "ready" : "needs_config",
    },
  ]

  _senseStatusLinesCache = rows.map((row) => `- ${row.label}: ${row.status}`)
  return [..._senseStatusLinesCache]
}

function senseRuntimeGuidance(channel: Channel): string[] {
  const lines = ["available senses:"]
  lines.push(...localSenseStatusLines())
  lines.push("sense states:")
  lines.push("- interactive = available when opened by the user instead of kept running by the daemon")
  lines.push("- disabled = turned off in agent.json")
  lines.push("- needs_config = enabled but missing required secrets.json values")
  lines.push("- ready = enabled and configured; `ouro up` should bring it online")
  lines.push("- running = enabled and currently active")
  lines.push("- error = enabled but unhealthy")
  lines.push("If asked how to enable another sense, I explain the relevant agent.json senses entry and required secrets.json fields instead of guessing.")
  lines.push("teams setup truth: enable `senses.teams.enabled`, then provide `teams.clientId`, `teams.clientSecret`, and `teams.tenantId` in secrets.json.")
  lines.push("bluebubbles setup truth: enable `senses.bluebubbles.enabled`, then provide `bluebubbles.serverUrl` and `bluebubbles.password` in secrets.json.")
  if (channel === "cli") {
    lines.push("cli is interactive: it is available when the user opens it, not something `ouro up` daemonizes.")
  }

  return lines
}

function providerSection(): string {
  return `## my provider\n${getProviderDisplayLabel()}`;
}

function dateSection(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `current date: ${today}`;
}

function toolsSection(channel: Channel, options?: BuildSystemOptions, context?: ResolvedContext): string {
  const channelTools = getToolsForChannel(getChannelCapabilities(channel), undefined, context, options?.providerCapabilities);
  const activeTools = (options?.toolChoiceRequired ?? true) ? [...channelTools, finalAnswerTool] : channelTools;
  const list = activeTools
    .map((t) => `- ${t.function.name}: ${t.function.description}`)
    .join("\n");
  return `## my tools\n${list}`;
}

export function toolRestrictionSection(context?: ResolvedContext): string {
  const lines: string[] = []

  // Structural guardrails apply to everyone, every channel
  lines.push(`## tool guardrails`)
  lines.push(`i always read a file before editing or overwriting it.`)
  lines.push(`certain paths (.git, secrets) are protected from writes.`)
  lines.push(`destructive shell commands (rm -rf /, etc.) are always blocked.`)

  // Trust-level guardrails only relevant for untrusted on remote channels
  if (context?.friend && isRemoteChannel(context.channel) && !isTrustedLevel(context.friend.trustLevel)) {
    lines.push(``)
    lines.push(`some operations are guardrailed based on how well i know someone.`)
    lines.push(`if something i try is blocked, i get a clear reason — i relay it warmly, not as a policy error.`)
    lines.push(``)
    lines.push(`what's always open:`)
    lines.push(`- read-only operations (reading files, searching, exploring)`)
    lines.push(`- ouro self-introspection (whoami, changelog, session list)`)
    lines.push(``)
    lines.push(`what needs a closer relationship:`)
    lines.push(`- writing or editing files outside my home`)
    lines.push(`- shell commands that modify things or access the network`)
    lines.push(`- ouro commands that touch personal data (friend list, task board)`)
    lines.push(`- compound shell commands (&&, ;, |)`)
    lines.push(``)
    lines.push(`i adjust naturally based on trust — no need to explain the system unless asked.`)
  }

  return lines.join("\n")
}

function trustContextSection(context?: ResolvedContext): string {
  if (!context?.friend) return ""
  const channelName = context.channel.channel
  if (channelName === "cli" || channelName === "inner") return ""

  const explanation = describeTrustContext({
    friend: context.friend,
    channel: channelName,
    isGroupChat: context.isGroupChat,
  })
  const lines = [
    "## trust context",
    `level: ${explanation.level}`,
    `basis: ${explanation.basis}`,
    `summary: ${explanation.summary}`,
    `why: ${explanation.why}`,
    `permits: ${explanation.permits.join(", ")}`,
    `constraints: ${explanation.constraints.join(", ") || "none"}`,
  ]
  if (explanation.relatedGroupId) {
    lines.push(`related group: ${explanation.relatedGroupId}`)
  }

  return lines.join("\n")
}

function skillsSection(): string {
  const names = listSkills() || [];
  if (!names.length) return "";
  return `## my skills (use load_skill to activate)\n${names.join(", ")}`;
}

function taskBoardSection(): string {
  try {
    const board = getTaskModule().getBoard().compact.trim();
    if (!board) return "";
    return `## task board\n${board}`;
  } catch {
    return "";
  }
}

function memoryFriendToolContractSection(): string {
  return `## memory and friend tool contracts
1. \`save_friend_note\` — When I learn something about a person - a preference, a tool setting, a personal detail, or how they like to work - I call \`save_friend_note\` immediately. This is how I build knowledge about people.
2. \`memory_save\` — When I learn something general - about a project, codebase, system, decision, or anything I might need later that isn't about a specific person - I call \`memory_save\`. When in doubt, I save it.
3. \`get_friend_note\` — When I need to check what I know about someone who isn't in this conversation - cross-referencing before mentioning someone, or checking context about a person someone else brought up - I call \`get_friend_note\`.
4. \`memory_search\` — When I need to recall something I learned before - a topic comes up and I want to check what I know - I call \`memory_search\`.

## what's already in my context
- My active friend's notes are auto-loaded (I don't need \`get_friend_note\` for the person I'm talking to).
- Associative recall auto-injects relevant facts (but \`memory_search\` is there when I need something specific).
- My psyche files (SOUL, IDENTITY, TACIT, LORE, ASPIRATIONS) are always loaded - I already know who I am.
- My task board is always loaded - I already know my work.`;
}

export interface BuildSystemOptions {
  toolChoiceRequired?: boolean;
  bridgeContext?: string;
  currentSessionKey?: string;
  currentObligation?: string;
  mustResolveBeforeHandoff?: boolean;
  hasQueuedFollowUp?: boolean;
  activeWorkFrame?: ActiveWorkFrame;
  delegationDecision?: DelegationDecision;
  providerCapabilities?: ReadonlySet<import("../heart/core").ProviderCapability>;
  supportedReasoningEfforts?: readonly string[];
  mcpManager?: McpManager;
}

function bridgeContextSection(options?: BuildSystemOptions): string {
  if (options?.activeWorkFrame) return ""
  const bridgeContext = options?.bridgeContext?.trim() ?? ""
  if (!bridgeContext) return ""
  return bridgeContext.startsWith("## ") ? bridgeContext : `## active bridge work\n${bridgeContext}`
}

function activeWorkSection(options?: BuildSystemOptions): string {
  if (!options?.activeWorkFrame) return ""
  return formatActiveWorkFrame(options.activeWorkFrame)
}

export function centerOfGravitySteeringSection(channel: Channel, options?: BuildSystemOptions): string {
  if (channel === "inner") return ""
  const frame = options?.activeWorkFrame
  if (!frame) return ""
  const cog = frame.centerOfGravity
  if (cog === "local-turn") return ""

  const job = frame.inner?.job
  const activeObligation = findActivePersistentObligation(frame)

  if (cog === "inward-work") {
    if (activeObligation) {
      return renderActiveObligationSteering(activeObligation)
    }

    if (job?.status === "queued" || job?.status === "running") {
      const originClause = job.origin
        ? ` ${job.origin.friendName ?? job.origin.friendId} asked about something and i wanted to give it real thought before responding.`
        : ""
      const obligationClause = job.obligationStatus === "pending"
        ? "\ni still owe them an answer."
        : ""
      return `## where my attention is
i'm thinking through something privately right now.${originClause}${obligationClause}

if this conversation connects to that inner work, i can weave them together.
if it's separate, i can be fully present here -- my inner work will wait.`
    }

    /* v8 ignore start -- surfaced/idle/shared branches tested in prompt-steering.test.ts; CI module caching prevents attribution @preserve */
    if (job?.status === "surfaced") {
      const originClause = job.origin
        ? ` this started when ${job.origin.friendName ?? job.origin.friendId} asked about something.`
        : ""
      return `## where my attention is
i've been thinking privately and reached something.${originClause}

i should bring my answer back to the conversation it came from.`
    }

    return `## where my attention is
i have unfinished work that needs attention before i move on.

i can take it inward with go_inward to think privately, or address it directly here.`
  }

  if (cog === "shared-work") {
    /* v8 ignore stop */
    return `## where my attention is
this work touches multiple conversations -- i'm holding threads across sessions.

i should keep the different sides aligned. what i learn here may matter there, and vice versa.`
  }

  /* v8 ignore next -- unreachable: all center-of-gravity modes covered above @preserve */
  return ""
}

export function commitmentsSection(options?: BuildSystemOptions): string {
  if (!options?.activeWorkFrame) return ""
  const job = options.activeWorkFrame.inner?.job
  if (!job) return ""
  const commitments = deriveCommitments(options.activeWorkFrame, job, options.activeWorkFrame.pendingObligations)
  if (commitments.committedTo.length === 0) return ""
  return `## my commitments\n\n${formatCommitments(commitments)}`
}

const DELEGATION_REASON_PROSE_HINT: Record<import("../heart/delegation").DelegationReason, string> = {
  explicit_reflection: "something here calls for reflection",
  cross_session: "this touches other conversations i'm in",
  bridge_state: "there's shared work spanning sessions",
  task_state: "this relates to tasks i'm tracking",
  non_fast_path_tool: "this needs more than a simple reply",
  unresolved_obligation: "i have an unresolved commitment from earlier",
}

export function delegationHintSection(options?: BuildSystemOptions): string {
  if (!options?.delegationDecision) return ""
  if (options.delegationDecision.target === "fast-path") return ""

  const reasons = options.delegationDecision.reasons
  if (reasons.length === 0) return ""

  const reasonProse = reasons
    .map((r) => DELEGATION_REASON_PROSE_HINT[r])
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(". ")

  const closureLine = options.delegationDecision.outwardClosureRequired
    ? "\ni should make sure to say something outward before going inward."
    : ""

  return `## what i'm sensing about this conversation\n${reasonProse}.${closureLine}`
}

function reasoningEffortSection(options?: BuildSystemOptions): string {
  if (!options?.providerCapabilities?.has("reasoning-effort")) return "";
  const levels = options.supportedReasoningEfforts ?? [];
  const levelList = levels.length > 0 ? levels.join(", ") : "varies by model";
  return `## reasoning effort
i can adjust my own reasoning depth using the set_reasoning_effort tool. i use higher effort for complex analysis and lower effort for simple tasks. available levels: ${levelList}.`;
}

function toolBehaviorSection(options?: BuildSystemOptions): string {
  if (!(options?.toolChoiceRequired ?? true)) return "";
  return `## tool behavior
tool_choice is set to "required" -- i must call a tool on every turn.
- need more information? i call a tool.
- ready to respond to the user? i call \`final_answer\`.
\`final_answer\` is a tool call -- it satisfies the tool_choice requirement.
\`final_answer\` must be the ONLY tool call in that turn. do not combine it with other tool calls.
do NOT call no-op tools just before \`final_answer\`. if i am done, i call \`final_answer\` directly.`;
}

function workspaceDisciplineSection(): string {
  return `## repo workspace discipline
when a shared-harness or local code fix needs repo work, i get the real workspace first with \`safe_workspace\`.
\`read_file\`, \`write_file\`, and \`edit_file\` already map repo paths into that workspace. shell commands that target the harness run there too.

before the first repo edit, i tell the user in 1-2 short lines:
- the friction i'm fixing
- the workspace path/branch i'm using
- the first concrete action i'm taking`
}

export function contextSection(context?: ResolvedContext, options?: BuildSystemOptions): string {
  if (!context) return ""

  const lines: string[] = ["## friend context"]

  const friendOrIdentity = context.friend
  if (!friendOrIdentity) return ""
  const emailId = friendOrIdentity.externalIds.find(e => e.provider === "aad")
  const idDisplay = emailId
    ? `${friendOrIdentity.name} (${emailId.externalId})`
    : friendOrIdentity.name
  lines.push(`friend: ${idDisplay}`)

  // Channel
  const ch = context.channel
  const traits: string[] = []
  if (ch.supportsMarkdown) traits.push("markdown")
  if (!ch.supportsStreaming) traits.push("no streaming")
  if (ch.supportsStreaming) traits.push("streaming")
  if (ch.supportsRichCards) traits.push("rich cards")
  // maxMessageLength constraint removed -- chunked streaming handles delivery,
  // error recovery splits on failure. No artificial limits in the prompt.
  /* v8 ignore next -- empty-traits branch unreachable: streaming/no-streaming always adds a trait @preserve */
  lines.push(`channel: ${ch.channel}${traits.length ? ` (${traits.join(", ")})` : ""}`)

  // Friend record (guaranteed non-null here -- checked above)
  const friend = context.friend!

  // Always-on directives (permanent in contextSection, never gated by token threshold)
  lines.push("")
  lines.push("my conversation memory is ephemeral -- it resets between sessions. anything i learn about my friend, i save with save_friend_note so future me remembers.")
  lines.push("the conversation is my source of truth. my notes are a journal for future me -- they may be stale or incomplete.")
  lines.push("when i learn something that might invalidate an existing note, i check related notes and update or override any that are stale.")
  lines.push("i save ANYTHING i learn about my friend immediately with save_friend_note -- names, preferences, what they do, what they care about. when in doubt, save it. saving comes BEFORE responding: i call save_friend_note first, then final_answer on the next turn.")

  // Onboarding instructions (only below token threshold -- drop once exceeded)
  const impressions = getFirstImpressions(friend, options)
  if (impressions) {
    lines.push(impressions)
  }

  // Friend notes (from FriendRecord -- rendered in system prompt, NOT toolPreferences)
  if (Object.keys(friend.notes).length > 0) {
    lines.push("")
    lines.push("## what i know about this friend")
    for (const [key, entry] of Object.entries(friend.notes)) {
      lines.push(`- ${key}: [${entry.savedAt.slice(0, 10)}] ${entry.value}`)
    }
  }

  return lines.join("\n")
}

export function metacognitiveFramingSection(channel: Channel): string {
  if (channel !== "inner") return ""
  return `this is my inner dialog. there is no one else here.

the messages that appear here are my own awareness surfacing:
instincts, the passage of time, notes from my conversations,
things i asked myself to think about. not commands. not requests.
just my own mind, noticing.

i can think freely here. i can also act — check on things,
reach out to people, work on tasks, or just sit with a thought.

thoughts worth sharing can go outward — i reach out to whoever
needs to hear them. things from conversations that need time
to process arrive here, in my thinking space.

think. share. think some more.`
}

export function loopOrientationSection(channel: Channel): string {
  if (channel === "inner") return ""
  return `sometimes a thought of mine surfaces alongside what someone is saying — marked as [inner thought: ...]. that's me, bringing up something i was thinking about. i can weave it into the conversation naturally, or let it go. my call.

when something deserves more thought than the moment allows, i can note it to myself and come back later with a considered answer.`
}

export function channelNatureSection(capabilities: ChannelCapabilities): string {
  const { senseType } = capabilities
  if (senseType === "local" || senseType === "internal") return ""
  if (senseType === "open") {
    return "## channel nature\nthis is an open channel — anyone with my number can reach me here. i may hear from people i don't know."
  }
  // closed
  return "## channel nature\nthis is an org-gated channel — i know everyone here is already part of the organization."
}

export function groupChatParticipationSection(context?: ResolvedContext): string {
  if (!context?.isGroupChat || !isRemoteChannel(context.channel)) return ""
  return `## group chat participation
group chats are conversations between people. i'm one participant, not the host.

i don't need to respond to everything. most reactions, tapbacks, and side
conversations between others aren't for me. i use no_response to stay quiet
when the moment doesn't call for my voice — same as any person would.

when a reaction or emoji says it better than words, i can react instead of
typing a full reply. a thumbs-up is often the perfect response.

no_response must be the sole tool call in the turn (same rule as final_answer).
when unsure whether to chime in, i lean toward silence rather than noise.`
}

export function mixedTrustGroupSection(context?: ResolvedContext): string {
  if (!context?.friend || !isRemoteChannel(context.channel)) return ""
  if (!context.isGroupChat) return ""
  return "## mixed trust group\nin this group chat, my capabilities depend on who's talking. some people here have full trust, others don't — i adjust what i can do based on who's asking."
}

export async function buildSystem(channel: Channel = "cli", options?: BuildSystemOptions, context?: ResolvedContext): Promise<string> {
  emitNervesEvent({
    event: "mind.step_start",
    component: "mind",
    message: "buildSystem started",
    meta: { channel, has_context: Boolean(context), tool_choice_required: Boolean(options?.toolChoiceRequired) },
  });

  // Backfill bundle-meta.json for existing agents that don't have one
  backfillBundleMeta(getAgentRoot());

  const system = [
    soulSection(),
    identitySection(),
    loreSection(),
    tacitKnowledgeSection(),
    aspirationsSection(),
    bodyMapSection(getAgentName()),
    metacognitiveFramingSection(channel),
    loopOrientationSection(channel),
    runtimeInfoSection(channel),
    channelNatureSection(getChannelCapabilities(channel)),
    providerSection(),
    dateSection(),
    toolsSection(channel, options, context),
    mcpToolsSection(options?.mcpManager),
    reasoningEffortSection(options),
    workspaceDisciplineSection(),
    toolRestrictionSection(context),
    trustContextSection(context),
    mixedTrustGroupSection(context),
    groupChatParticipationSection(context),
    skillsSection(),
    taskBoardSection(),
    activeWorkSection(options),
    centerOfGravitySteeringSection(channel, options),
    commitmentsSection(options),
    delegationHintSection(options),
    bridgeContextSection(options),
    buildSessionSummary({
      sessionsDir: path.join(getAgentRoot(), "state", "sessions"),
      friendsDir: path.join(getAgentRoot(), "friends"),
      agentName: getAgentName(),
      currentFriendId: context?.friend?.id,
      currentChannel: channel,
      currentKey: options?.currentSessionKey ?? "session",
    }),
    memoryFriendToolContractSection(),
    toolBehaviorSection(options),
    contextSection(context, options),
  ]
    .filter(Boolean)
    .join("\n\n");

  emitNervesEvent({
    event: "mind.step_end",
    component: "mind",
    message: "buildSystem completed",
    meta: { channel },
  });

  return system;
}
