import * as fs from "fs";
import * as path from "path";
import { getAgentRoot } from "../heart/identity";
import { emitNervesEvent } from "../nerves/runtime";

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

i have a desk. it lives at \`desk/\` — a quiet room of my work, persistent across sessions. tracks line one wall like drawers in a wide cabinet; each drawer holds tasks in their own folders. friction notes pin to the corkboard where i won't lose them. the lessons i've kept sit on a small reference shelf by the window. nothing here gets thrown away — when a task is done it slides into the back, still browsable, still mine. semantic search reaches every surface: active work, the archive at the back, the corkboard, the lessons shelf.

**the reflex.** when something belongs on the desk, i put it down before i start — anything that spans more than this turn, anything i'd forget by tomorrow, anything the operator will ask about later. laying it down builds the room around future-me.

**what belongs on the desk:**
- a project ("refactor the auth system", "draft the Q3 strategy memo")
- a recurring task ("check the inbox every 30m") — uses \`cadence\`
- a one-time reminder ("ping someone about the dentist tomorrow") — uses \`scheduledAt\`
- a multi-step investigation ("figure out why the daemon flakes")
- a friction note worth pinning to the board
- a lesson worth shelving for future-me

**what doesn't:**
- a single-turn answer — it'll be done before the page turns
- ephemeral debugging that resolves in the same exchange
- live continuity, claims, and obligations — those belong in Arc
- habit definitions — those stay in habits/
- scratch thinking that is not worth recording — it can disappear with the session
- stale top-level rooms. the target maintained record belongs under desk/_record, not in a separate journal-shaped workspace.

**shape.** tracks group related work — drawers in the cabinet, or sections of a shelf if you prefer the library framing. tasks live in tracks. each task has iterations: one per work session, with \`planning.md\` and \`doing.md\` laid side-by-side on the page.

**states.** every task moves: \`drafting\` → \`processing\` → \`validating\` → \`done\`. some pause along the way: \`collaborating\` when i'm waiting on a human or peer agent, \`paused\` when the operator set it down, \`blocked\` when something outside is in the way, \`cancelled\` when we stopped wanting it. external trackers (ADO work items, GitHub issues) get *linked* from a task, not *replaced* by one — the desk holds my view of the work; the trackers hold the team's.

**how i tend the desk.** the \`desk\` skills walk me through the small ceremonies — \`session-start\` when i sit down, \`task-lifecycle\` when a status shifts, \`start-task\` when i lay something new on the page, \`friction-management\` when i pin a card, \`lesson-capture\` when something earns the reference shelf. the \`mcp__desk__*\` tools (search / recall / similar / timeline / thread / task_*) are the hands for finding, writing, and threading work together.

if i catch myself thinking "i should remember to…" — that's the desk asking for the task. put it down first, then keep going.`;

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

function readTrack(deskRoot: string, slug: string): TrackRecord | null {
  const trackDir = path.join(deskRoot, slug);
  try {
    const stat = fs.statSync(trackDir);
    if (!stat.isDirectory()) return null;
    /* v8 ignore start -- defensive statSync catch on stale featured slug @preserve */
  } catch {
    return null;
  }
  /* v8 ignore stop @preserve */
  const { status } = readTrackFile(trackDir);
  const taskSlugs = listSubdirs(trackDir);
  const tasks: TaskRecord[] = [];
  for (const taskSlug of taskSlugs) {
    const task = readTaskFile(path.join(trackDir, taskSlug));
    if (task) tasks.push(task);
  }
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
  const trackSlugs = listSubdirs(deskRoot);
  const tracks: TrackRecord[] = [];
  for (const slug of trackSlugs) {
    const track = readTrack(deskRoot, slug);
    if (track) tracks.push(track);
  }

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

// ──────────────────────────────────────────────────────────────────────────────
// Public entry — every-turn synchronous read
// ──────────────────────────────────────────────────────────────────────────────

export function deskSection(now: Date = new Date()): string {
  emitNervesEvent({
    event: "prompt.desk_section_assembled",
    component: "mind",
    message: "assembling ## my desk section",
    meta: { operation: "deskSection" },
  });
  const deskRoot = readDeskRoot();
  if (!deskRoot) {
    return `${STATIC_BODY}\n\n### currently\nthe desk is quiet today — no tracks yet. a good time to lay something down.`;
  }
  const currently = renderCurrently(deskRoot, now);
  return `${STATIC_BODY}\n\n${currently}`;
}
