import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getAgentRoot } from "../heart/identity";
import { agentDesks, type AgentDesk } from "../repertoire/desk-mcp";
import { emitNervesEvent } from "../nerves/runtime";
import { resolveDeskRecordPaths } from "./record-paths";

// ──────────────────────────────────────────────────────────────────────────────
// Static body — the agent's daily-read description of its desk.
//
// This is the room every ouro agent sits down in at the top of every turn.
// The voice is intentional: lowercase, second-person-implied, physical
// metaphor (drawers, corkboard, reference shelf, back-of-room archive). The
// goal is that an agent reading this every turn feels at home rather than
// being briefed — the desk is the agent's place, not a system being
// explained to it.
// ──────────────────────────────────────────────────────────────────────────────

const STATIC_BODY = `## my desk

i have a desk at \`desk/\`: durable work that persists across sessions. it is a Desk, the same kind my operator's coding agents (Claude Code, Codex, Copilot) work on, and Desk is built into me. tracks group related work; each task is a folder with a \`task.md\` card; friction notes and lessons live there too, and finished tasks stay browsable.

**i change a desk only through Desk's tools**, \`mcp__desk__*\` for my own: \`task_create\`, \`task_update\` (progress, status, next step, log), \`task_archive\`, \`track_create\`, \`friction_add\`, \`lesson_add\`, \`note\`, and \`desk_save\` for any other file. \`desk_search\` and \`desk_recall\` find things, \`desk_status\` and \`desk_doctor\` say how the desk is and what to fix, and \`desk_skill\` reads Desk's own how-to skills. the tools commit and push each change themselves, so i never hand-edit desk files or commit them with git: a hand edit skips Desk's checks, and a shared desk refuses commits Desk didn't make. reading the files directly is fine. \`desk/_record/\` is my diary and notes, which my diary and note tools keep; it is not part of Desk.

**the reflex.** when something spans more than this turn, i'd forget it by tomorrow, or the operator will ask about it later, i put it on the desk before i start: a project, a recurring task (\`cadence\`), a one-time reminder (\`scheduledAt\`), a multi-step investigation, a friction note, a lesson.

**what doesn't belong:** a single-turn answer, debugging that resolves in the same exchange, scratch thinking, live continuity, claims and obligations (those are Arc), habit definitions (those stay in habits/), or a separate scratch workspace.

**states.** \`drafting\` → \`processing\` → \`validating\` → \`done\`; \`collaborating\` when i'm waiting on a human or peer agent, \`paused\` when the operator set it down, \`blocked\` when something outside is in the way, \`cancelled\` when we stopped wanting it. external trackers (ADO work items, GitHub issues) are linked from a task, not replaced by one.`;

/** The other desks this agent looks after, each with its own Desk server, or nothing when there are none. */
export function otherDesksBlock(desks: readonly AgentDesk[], home = os.homedir()): string {
  const others = desks.filter((desk) => desk.name !== null);
  if (others.length === 0) return "";
  const shown = (root: string) => (root.startsWith(home + path.sep) ? `~${root.slice(home.length)}` : root);
  const lines = ["### other desks i look after", "each has its own Desk server and the same tools; the same rule holds: only through the tools."];
  for (const desk of others) {
    lines.push(desk.present
      ? `- ${desk.name}, at ${shown(desk.root)}: \`mcp__${desk.server}__*\``
      : `- ${desk.name}: not on this machine (expected at ${shown(desk.root)}), so its tools are off here`);
  }
  return lines.join("\n");
}

const TERMINAL_TASK_STATUSES = new Set(["done", "cancelled"]);
const TERMINAL_TRACK_STATUSES = new Set(["closed"]);
const TOP_N_TASKS_PER_FEATURED = 3;

// ──────────────────────────────────────────────────────────────────────────────
// Tiny frontmatter parser — local, just enough for `status` + `updated` reads.
// schema_version: 0 (no field) and schema_version: 1 parse identically here
// because both keep `status` and `updated` at top level.
// ──────────────────────────────────────────────────────────────────────────────

function parseScalar(raw: string): string {
  const value = raw.trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseFrontmatter(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return out;
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing === -1) return out;
  for (let i = 1; i < closing; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const match = /^([A-Za-z0-9_:-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const inline = match[2];
    if (inline.length === 0) continue;
    out[key] = parseScalar(inline);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Filesystem readers
// ──────────────────────────────────────────────────────────────────────────────

interface TaskRecord {
  slug: string;
  status: string;
  updated: string | null;
}

interface TrackRecord {
  slug: string;
  status: string;
  tasks: TaskRecord[];
}

function readDeskRoot(): string | null {
  try {
    const root = path.join(getAgentRoot(), "desk");
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) return null;
    return root;
  } catch {
    return null;
  }
}

function readTrackFile(trackDir: string): { status: string } {
  try {
    const raw = fs.readFileSync(path.join(trackDir, "track.md"), "utf-8");
    const fm = parseFrontmatter(raw);
    return { status: fm.status ?? "active" };
  } catch {
    return { status: "active" };
  }
}

function readTaskFile(taskDir: string): TaskRecord | null {
  try {
    const raw = fs.readFileSync(path.join(taskDir, "task.md"), "utf-8");
    const fm = parseFrontmatter(raw);
    return {
      slug: path.basename(taskDir),
      status: fm.status ?? "drafting",
      updated: fm.updated ?? null,
    };
  } catch {
    return null;
  }
}

function listSubdirs(parent: string): string[] {
  /* v8 ignore start -- defensive readdir catch only fires on transient FS errors @preserve */
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
  /* v8 ignore stop @preserve */
}

/** A track folder, which `listSubdirs` has already found. */
function readTrack(deskRoot: string, slug: string): TrackRecord {
  const trackDir = path.join(deskRoot, slug);
  const { status } = readTrackFile(trackDir);
  const tasks = listSubdirs(trackDir)
    .map((taskSlug) => readTaskFile(path.join(trackDir, taskSlug)))
    .filter((task): task is TaskRecord => task !== null);
  return { slug, status, tasks };
}

function readFeaturedList(deskRoot: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(deskRoot, "_meta", "featured.md"), "utf-8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Relative-time formatter — no deps, plain English short form
// ──────────────────────────────────────────────────────────────────────────────

export function formatRelative(updated: string | null, now: Date = new Date()): string {
  if (!updated) return "unknown";
  const then = new Date(updated);
  if (Number.isNaN(then.getTime())) return "unknown";
  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Featured-track resolution
// ──────────────────────────────────────────────────────────────────────────────

function isTrackEligibleAsFeatured(track: TrackRecord): boolean {
  return !TERMINAL_TRACK_STATUSES.has(track.status);
}

function pickFeatured(tracks: TrackRecord[], featuredList: string[]): TrackRecord | null {
  const bySlug = new Map(tracks.map((t) => [t.slug, t]));
  for (const slug of featuredList) {
    const track = bySlug.get(slug);
    if (track && isTrackEligibleAsFeatured(track)) return track;
  }
  for (const track of tracks) {
    if (isTrackEligibleAsFeatured(track)) return track;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Currently block — assembly
// ──────────────────────────────────────────────────────────────────────────────

function nonTerminalTasks(track: TrackRecord): TaskRecord[] {
  return track.tasks.filter((t) => !TERMINAL_TASK_STATUSES.has(t.status));
}

function sortOldestUpdatedFirst(tasks: TaskRecord[]): TaskRecord[] {
  return tasks.slice().sort((a, b) => {
    const aTime = a.updated ? new Date(a.updated).getTime() : Number.POSITIVE_INFINITY;
    const bTime = b.updated ? new Date(b.updated).getTime() : Number.POSITIVE_INFINITY;
    if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
    if (Number.isNaN(aTime)) return 1;
    if (Number.isNaN(bTime)) return -1;
    return aTime - bTime;
  });
}

function renderCurrently(deskRoot: string, now: Date = new Date()): string {
  const tracks = listSubdirs(deskRoot).map((slug) => readTrack(deskRoot, slug));

  if (tracks.length === 0) {
    return "### currently\nthe desk is quiet today — no tracks yet. a good time to lay something down.";
  }

  const featuredList = readFeaturedList(deskRoot);
  const featured = pickFeatured(tracks, featuredList);

  if (!featured) {
    return "### currently\nthe desk is quiet today — no tracks yet. a good time to lay something down.";
  }

  const featuredTasks = sortOldestUpdatedFirst(nonTerminalTasks(featured)).slice(
    0,
    TOP_N_TASKS_PER_FEATURED,
  );

  const lines: string[] = ["### currently"];
  lines.push(`nearest the front of the desk: ${featured.slug}   (status: ${featured.status})`);
  for (const task of featuredTasks) {
    lines.push(
      `  → ${task.slug}   (status: ${task.status}, updated: ${formatRelative(task.updated, now)})`,
    );
  }

  const otherActive = tracks
    .filter((t) => t.slug !== featured.slug && !TERMINAL_TRACK_STATUSES.has(t.status))
    .map((t) => t.slug);
  if (otherActive.length > 0) {
    lines.push(`also open on the desk: ${otherActive.join(", ")}`);
  }

  const nonTerminalCount = tracks.reduce((sum, t) => sum + nonTerminalTasks(t).length, 0);
  lines.push(`tasks still open: ${nonTerminalCount}`);

  return lines.join("\n");
}

function countDiaryFacts(agentRoot: string): number {
  const paths = resolveDeskRecordPaths(agentRoot);
  try {
    return fs.readFileSync(paths.factsPath, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .length;
  } catch {
    return 0;
  }
}

function countRecordNotes(agentRoot: string): number {
  const paths = resolveDeskRecordPaths(agentRoot);
  try {
    return fs.readdirSync(paths.notesRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && entry.name.endsWith(".md"))
      .length;
  } catch {
    return 0;
  }
}

export function deskRecordOrientationSection(agentRoot = getAgentRoot(), now: Date = new Date()): string {
  const deskRoot = path.join(agentRoot, "desk");
  const tracks = listSubdirs(deskRoot).map((slug) => readTrack(deskRoot, slug));
  const activeTracks = tracks.filter((track) => !TERMINAL_TRACK_STATUSES.has(track.status));
  const openTaskCount = tracks.reduce((sum, track) => sum + nonTerminalTasks(track).length, 0);
  const lines = ["## Desk orientation"];
  lines.push(`active tracks: ${activeTracks.length}`);
  lines.push(`open tasks: ${openTaskCount}`);
  lines.push(`diary facts: ${countDiaryFacts(agentRoot)}`);
  lines.push(`record notes: ${countRecordNotes(agentRoot)}`);
  const currently = fs.existsSync(deskRoot) ? renderCurrently(deskRoot, now) : "";
  if (currently) lines.push(currently);
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Public entry — every-turn synchronous read
// ──────────────────────────────────────────────────────────────────────────────

export function deskSection(now: Date = new Date(), desks: readonly AgentDesk[] = agentDesks()): string {
  emitNervesEvent({
    event: "prompt.desk_section_assembled",
    component: "mind",
    message: "assembling ## my desk section",
    meta: { operation: "deskSection", otherDesks: desks.length - 1 },
  });
  const deskRoot = readDeskRoot();
  const currently = deskRoot
    ? renderCurrently(deskRoot, now)
    : "### currently\nthe desk is quiet today — no tracks yet. a good time to lay something down.";
  return [STATIC_BODY, currently, otherDesksBlock(desks)].filter(Boolean).join("\n\n");
}
