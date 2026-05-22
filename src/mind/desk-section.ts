import * as fs from "fs";
import * as path from "path";
import { getAgentRoot } from "../heart/identity";

// ──────────────────────────────────────────────────────────────────────────────
// Static body — Candidate D synthesis (verbatim from
// worker-generalization/2026-05-20-w6-desk-as-universal-substrate/design-decisions.md §10)
// ──────────────────────────────────────────────────────────────────────────────

const STATIC_BODY = `## my desk

every ouro agent has a desk. mine is at \`desk/\`. it's where my work lives across sessions — the source of truth for what i'm doing, what's queued, what's paused, what's done.

**the reflex:** if work spans more than this turn, OR i'd forget it after this turn, OR it's something the operator will ask about later — it goes on desk *now*, before i start.

**what belongs:**
- a project ("refactor the auth system", "draft the Q3 strategy memo")
- a recurring task ("check the inbox every 30m") — uses \`cadence\`
- a one-time reminder ("ping ari about the dentist tomorrow") — uses \`scheduledAt\`
- a multi-step investigation ("figure out why the daemon flakes")
- a friction note or lesson worth keeping

**what doesn't:**
- a single-turn answer
- ephemeral debugging that resolves in the same exchange
- work that has its own first-class system (trips, habits, attention items, diary entries, journal entries — those have their own homes; desk LINKS to them when relevant)

**shape:** tracks group related work (e.g. "harness-care", "summer-2026-europe-trip", or one per repo / feature area). tasks live in tracks. each task has iterations — one per work session, with \`planning.md\` and \`doing.md\`.

**states:** \`drafting\` → \`processing\` → \`validating\` → \`done\`. plus \`collaborating\` (waiting on a human or peer agent), \`paused\` (operator deferred), \`blocked\` (external dependency), \`cancelled\`. external trackers (ADO, GitHub issues) get linked from the task, not replaced by it.

**how i interact:**
- \`desk\` skills walk me through the moments: \`session-start\` (top of every session), \`task-lifecycle\` (on state change), \`start-task\`, \`friction-management\`, \`lesson-capture\`.
- \`mcp__desk__*\` tools (search/recall/similar/timeline/thread/task_*) for runtime ops.

if i catch myself thinking "i should remember to…" — that's the desk signal. add the task first, then keep going.`;

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
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function readTrack(deskRoot: string, slug: string): TrackRecord | null {
  const trackDir = path.join(deskRoot, slug);
  try {
    const stat = fs.statSync(trackDir);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
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
    return "### currently\nempty — no tracks yet.";
  }

  const featuredList = readFeaturedList(deskRoot);
  const featured = pickFeatured(tracks, featuredList);

  if (!featured) {
    return "### currently\nempty — no tracks yet.";
  }

  const featuredTasks = sortOldestUpdatedFirst(nonTerminalTasks(featured)).slice(
    0,
    TOP_N_TASKS_PER_FEATURED,
  );

  const lines: string[] = ["### currently"];
  lines.push(`FEATURED: ${featured.slug}   (status: ${featured.status})`);
  for (const task of featuredTasks) {
    lines.push(
      `  → ${task.slug}   (status: ${task.status}, updated: ${formatRelative(task.updated, now)})`,
    );
  }

  const otherActive = tracks
    .filter((t) => t.slug !== featured.slug && !TERMINAL_TRACK_STATUSES.has(t.status))
    .map((t) => t.slug);
  if (otherActive.length > 0) {
    lines.push(`other active tracks: ${otherActive.join(", ")}`);
  }

  const nonTerminalCount = tracks.reduce((sum, t) => sum + nonTerminalTasks(t).length, 0);
  lines.push(`non-terminal tasks: ${nonTerminalCount}`);

  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Public entry — every-turn synchronous read
// ──────────────────────────────────────────────────────────────────────────────

export function deskSection(now: Date = new Date()): string {
  const deskRoot = readDeskRoot();
  if (!deskRoot) {
    return `${STATIC_BODY}\n\n### currently\nempty — no tracks yet.`;
  }
  const currently = renderCurrently(deskRoot, now);
  return `${STATIC_BODY}\n\n${currently}`;
}
