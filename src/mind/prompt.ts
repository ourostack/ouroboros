import * as fs from "fs";
import * as path from "path";
import { getProviderDisplayLabel } from "../heart/core";
import { finalAnswerTool, getToolsForChannel, REMOTE_BLOCKED_LOCAL_TOOLS } from "../repertoire/tools";
import { listSkills } from "../repertoire/skills";
import { getAgentRoot, getAgentName, getAgentSecretsPath, loadAgentConfig, type SenseName } from "../heart/identity";
import { isTrustedLevel, type Channel, type ChannelCapabilities, type ResolvedContext } from "./friends/types";
import { getChannelCapabilities, isRemoteChannel } from "./friends/channel";
import { emitNervesEvent } from "../nerves/runtime";
import { backfillBundleMeta, getPackageVersion, getChangelogPath } from "./bundle-manifest";
import type { BundleMeta } from "./bundle-manifest";
import { getFirstImpressions } from "./first-impressions";
import { getTaskModule } from "../repertoire/tasks";

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

interface SessionEntry {
  friendId: string
  displayName: string
  channel: string
  key: string
  lastActivityMs: number
}

function resolveFriendName(friendId: string, friendsDir: string, agentName: string): string {
  if (friendId === "self") return agentName
  try {
    const raw = fs.readFileSync(path.join(friendsDir, `${friendId}.json`), "utf-8")
    const record = JSON.parse(raw) as { name?: string }
    return record.name ?? friendId
  } catch {
    return friendId
  }
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

  if (!fs.existsSync(sessionsDir)) return ""

  const now = Date.now()
  const entries: SessionEntry[] = []

  let friendDirs: string[]
  try {
    friendDirs = fs.readdirSync(sessionsDir)
  } catch {
    return ""
  }

  for (const friendId of friendDirs) {
    const friendPath = path.join(sessionsDir, friendId)
    let channels: string[]
    try {
      channels = fs.readdirSync(friendPath)
    } catch {
      continue
    }

    for (const channel of channels) {
      const channelPath = path.join(friendPath, channel)
      let keys: string[]
      try {
        keys = fs.readdirSync(channelPath)
      } catch {
        continue
      }

      for (const keyFile of keys) {
        if (!keyFile.endsWith(".json")) continue
        const key = keyFile.replace(/\.json$/, "")

        // Exclude current session
        if (friendId === currentFriendId && channel === currentChannel && key === currentKey) {
          continue
        }

        const filePath = path.join(channelPath, keyFile)
        let mtimeMs: number
        try {
          mtimeMs = fs.statSync(filePath).mtimeMs
        } catch {
          continue
        }

        if (now - mtimeMs > activeThresholdMs) continue

        const displayName = resolveFriendName(friendId, friendsDir, agentName)
        entries.push({ friendId, displayName, channel, key, lastActivityMs: mtimeMs })
      }
    }
  }

  if (entries.length === 0) return ""

  // Sort by most recent first
  entries.sort((a, b) => b.lastActivityMs - a.lastActivityMs)

  const lines: string[] = ["## active sessions"]
  for (const entry of entries) {
    const ago = formatTimeAgo(now - entry.lastActivityMs)
    lines.push(`- ${entry.displayName}/${entry.channel}/${entry.key} (last: ${ago})`)
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

my bones give me the \`ouro\` cli:
  ouro whoami            who i am, where i live, what i'm running on
  ouro task board        my task board
  ouro task create       start a new task (--type required)
  ouro task update       move a task forward
  ouro friend list       people i know and how to reach them
  ouro friend show <id>  everything i know about someone
  ouro session list      my open conversations right now
  ouro reminder create   remind myself about something later
  ouro --help            the full list`
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
  const channelTools = getToolsForChannel(getChannelCapabilities(channel), undefined, context);
  const activeTools = (options?.toolChoiceRequired ?? true) ? [...channelTools, finalAnswerTool] : channelTools;
  const list = activeTools
    .map((t) => `- ${t.function.name}: ${t.function.description}`)
    .join("\n");
  return `## my tools\n${list}`;
}

export function toolRestrictionSection(context?: ResolvedContext): string {
  if (!context?.friend || !isRemoteChannel(context.channel)) return ""

  if (isTrustedLevel(context.friend.trustLevel)) return ""

  const toolList = [...REMOTE_BLOCKED_LOCAL_TOOLS].join(", ")
  return `## restricted tools
some of my tools are unavailable right now: ${toolList}

i don't know this person well enough yet to run local operations on their behalf. i can suggest remote-safe alternatives or ask them to run it from CLI.`
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
}

function bridgeContextSection(options?: BuildSystemOptions): string {
  const bridgeContext = options?.bridgeContext?.trim() ?? ""
  if (!bridgeContext) return ""
  return bridgeContext.startsWith("## ") ? bridgeContext : `## active bridge work\n${bridgeContext}`
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
    toolRestrictionSection(context),
    mixedTrustGroupSection(context),
    skillsSection(),
    taskBoardSection(),
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
