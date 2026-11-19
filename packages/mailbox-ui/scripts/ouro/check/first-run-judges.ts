export type AxNode = {
  /**
   * Index in the flattened, depth-first list; `p` is the parent's index (-1 for the window), `d` the depth.
   * @claim "Index in the flattened, depth-first list" scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the judges > a subtree is the node and the run of deeper nodes after it, and a bad index has none)
   */
  i: number;
  p: number;
  d: number;
  role: string;
  subrole?: string;
  /** Title, description and value, joined with " | ". */
  words?: string;
  enabled: boolean;
  focused?: boolean;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** The web content's own DOM id and classes, where the element is a web element. */
  domId?: string;
  domClass?: string[];
};
/** A window and its elements, flattened depth first. */
export type AxWindow = { title: string; x: number; y: number; w: number; h: number; nodes: AxNode[] };

// First-run harness: the judges. Plain functions of what a gate read from the screen (the accessibility tree, which for a web
// view mirrors its DOM, and a screenshot's pixels), so a test can hand them made-up readings. Generic: no app names; an app
// passes its own words (what moves a person forward, what an empty-but-signed-in screen says, what a progress line says).
//
// The rules, for every state on a first run's path, from a fresh install to signed in and synced:
//   no blank screen   the pane (the topmost dialog, else the page's main landmark, else its web area, else the window) shows
//                     something to read or a named progress state within `blankWithinMs` of arriving
//   no dead end       the state offers at least one enabled control that moves the person forward, or is the goal, or is a
//                     named progress state that ends within `progressWithinMs`
//   no dismissable required step   a dialog that Escape, its close button or a click outside takes away must leave a state
//                     that passes the two rules above (and the next)
//   signed-out truth  while the person is signed out, nothing on screen says the empty-but-signed-in thing ("nothing new")

export type Pixels = { uniform: number; mean: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** One look at the app: its windows, the pane's pixels when a screenshot was read, and whether the person is signed in (null: unknown). */
export type Snapshot = { at: number; windows: AxWindow[]; pixels?: Pixels | null; signedIn: boolean | null };

export type Vocabulary = {
  /** A control whose words match moves the person forward: Sign in, Retry, Continue. */
  forward: RegExp;
  /** Words that name a progress state: "Signing you in…". A progress indicator's role counts without words. */
  progress: RegExp;
  /**
   * What a signed-in person's empty screen says, which a signed-out person must never read: "All caught up".
   * @claim "What a signed-in person's empty screen says" scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the judges > signed out, an empty signed-in screen's words fail; signed in or unknown they pass)
   */
  emptyWhileSignedIn: RegExp;
  /** Words on a dialog's own close control. */
  close: RegExp;
};

export const DEFAULT_VOCABULARY: Vocabulary = {
  forward: /^(Sign in|Sign in again|Log in|Retry|Try again|Continue|Next|Get started|Open|Yes|No|OK|Done|Skip)$/i,
  progress: /(…|\.\.\.)$|^(Loading|Signing|Starting|Getting|Connecting|Syncing|Reading)\b/i,
  emptyWhileSignedIn: /All caught up|No (chats|messages|conversations) yet|Nothing new|You're all set|Inbox zero/i,
  close: /^(Close|Dismiss|Cancel|×|✕)$/i,
};

const DIALOG_SUBROLES = new Set(["AXApplicationDialog", "AXApplicationAlertDialog", "AXDialog", "AXSystemDialog"]);
const PRESSABLE = new Set(["AXButton", "AXLink", "AXMenuItem", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXTab"]);
const READABLE = new Set([...PRESSABLE, "AXStaticText", "AXHeading", "AXTextField", "AXTextArea", "AXImage", "AXCell", "AXRow", "AXListItem"]);
const PROGRESS_ROLES = new Set(["AXProgressIndicator", "AXBusyIndicator"]);
/**
 * A pane where one shade covers this much of it (read at 192×144) has nothing drawn on it, whatever its tree lists. A sparse
 * page is not blank: a sign-in card with one field and a line of text on white read 98.6%.
 * @claim "A pane where one shade covers this" scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the judges > words over a pane of one shade are still blank, but a sparse page is not)
 * @claim "A sparse page is not blank:" scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the judges > words over a pane of one shade are still blank, but a sparse page is not) verify:fileLine(scripts/check/first-run-units.test.mts, /uniform: 0\.986/)
 */
export const UNIFORM_BLANK = 0.9995;
/** A tree this thin under a pane of one shade is blank. */
export const THIN_TREE = 2;

export const visible = (n: AxNode) => (n.w ?? 0) > 4 && (n.h ?? 0) > 4;
// Only a window, or a node `visible` let through, which has a size; a node's place can be missing.
const rectOf = (n: AxNode | AxWindow): Rect => ({ x: n.x ?? 0, y: n.y ?? 0, w: n.w!, h: n.h! });

/**
 * The node and everything under it: the flattened list is depth-first, so it is the run of deeper nodes after it.
 * @claim "The node and everything under it" scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the judges > a subtree is the node and the run of deeper nodes after it, and a bad index has none)
 */
export function subtree(nodes: AxNode[], at: number): AxNode[] {
  const root = nodes[at];
  if (!root) return [];
  let end = at + 1;
  while (end < nodes.length && nodes[end]!.d > root.d) end++;
  return nodes.slice(at, end);
}

/**
 * The app's main window: the largest titled-or-not standard window on screen.
 * @claim "The app's main window: the largest" scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the judges > the main window is the largest window on screen, and tiny windows are none)
 */
export function mainWindow(s: Snapshot): AxWindow | null {
  return [...s.windows].filter((w) => w.w > 200 && w.h > 150).sort((a, b) => b.w * b.h - a.w * a.h)[0] ?? null;
}

/**
 * Every dialog on screen, in drawing order (the last is the topmost): web dialogs, sheets, and alert windows.
 * @claim "Every dialog on screen, in drawing" scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the judges > dialogs are web dialogs, sheets and alert windows, but not the main window itself)
 */
export function dialogs(s: Snapshot): { window: AxWindow; node: AxNode; nodes: AxNode[] }[] {
  const out: { window: AxWindow; node: AxNode; nodes: AxNode[] }[] = [];
  for (const w of s.windows) {
    for (const n of w.nodes) {
      const isDialog = n.role === "AXSheet" || (n.subrole !== undefined && DIALOG_SUBROLES.has(n.subrole) && (n.p >= 0 || w !== mainWindow(s)));
      if (isDialog && visible(n)) out.push({ window: w, node: n, nodes: subtree(w.nodes, n.i) });
    }
  }
  return out;
}

export type Pane = { kind: "dialog" | "main" | "web" | "window" | "none"; nodes: AxNode[]; rect: Rect; label: string };

/** Where the person looks: the topmost dialog, else the page's main landmark, else its web area, else the whole window. */
export function pane(s: Snapshot): Pane {
  const top = dialogs(s).at(-1);
  if (top) return { kind: "dialog", nodes: top.nodes, rect: rectOf(top.node), label: dialogLabel(top.nodes) };
  const win = mainWindow(s);
  if (!win) return { kind: "none", nodes: [], rect: { x: 0, y: 0, w: 0, h: 0 }, label: "no window" };
  const largest = (pick: (n: AxNode) => boolean) => win.nodes.filter((n) => pick(n) && visible(n)).sort((a, b) => (b.w! * b.h!) - (a.w! * a.h!))[0];
  const main = largest((n) => n.subrole === "AXLandmarkMain");
  if (main) return { kind: "main", nodes: subtree(win.nodes, main.i), rect: rectOf(main), label: "the main pane" };
  const web = largest((n) => n.role === "AXWebArea");
  if (web) return { kind: "web", nodes: subtree(win.nodes, web.i), rect: rectOf(web), label: "the page" };
  return { kind: "window", nodes: win.nodes, rect: rectOf(win), label: "the window" };
}

/** Where the page's own content is, under any dialog: its main landmark, else its web area, else the window. */
export function mainRect(s: Snapshot): Rect | null {
  const win = mainWindow(s);
  if (!win) return null;
  const largest = (pick: (n: AxNode) => boolean) => win.nodes.filter((n) => pick(n) && visible(n)).sort((a, b) => b.w! * b.h! - a.w! * a.h!)[0];
  const main = largest((x) => x.subrole === "AXLandmarkMain");
  if (main) return rectOf(main);
  // Under a modal dialog the page's main landmark can be out of the tree: the web area, less a navigation rail at its side.
  const web = largest((x) => x.role === "AXWebArea");
  if (!web) return rectOf(win);
  const r = rectOf(web);
  const rail = largest((x) => x.subrole === "AXLandmarkNavigation" && Math.abs((x.x ?? 0) - r.x) < 4 && (x.h ?? 0) > r.h / 2 && (x.w ?? 0) < r.w / 3);
  return rail ? { x: r.x + rail.w!, y: r.y, w: r.w - rail.w!, h: r.h } : r;
}

/**
 * The longest time the pane was one shade, from fast pixel reads: a run from its first blank read to the next read with
 * something on it (or the last read).
 */
export function longestBlank(reads: { at: number; uniform: number }[], uniformBlank = UNIFORM_BLANK): { at: number; ms: number } {
  let worst = { at: 0, ms: 0 };
  let start: number | null = null;
  for (const [i, r] of reads.entries()) {
    const blank = r.uniform >= uniformBlank;
    if (blank && start === null) start = r.at;
    const ends = !blank || i === reads.length - 1;
    if (start !== null && ends) {
      const ms = r.at - start;
      if (ms > worst.ms) worst = { at: start, ms };
      if (!blank) start = null;
    }
  }
  return worst;
}

/** A dialog's name: its first heading, else its own words, else its first text. */
export function dialogLabel(nodes: AxNode[]): string {
  const heading = nodes.find((n) => n.role === "AXHeading" && n.words);
  return (heading?.words ?? nodes[0]?.words ?? nodes.find((n) => n.role === "AXStaticText" && n.words)?.words ?? "a dialog").slice(0, 80);
}

const readable = (nodes: AxNode[]) => nodes.filter((n) => READABLE.has(n.role) && !!n.words && visible(n));

/** The named progress state the pane shows, if any: a progress indicator, or words that say something is under way. */
export function progressOf(nodes: AxNode[], v: Vocabulary): string | null {
  const bar = nodes.find((n) => PROGRESS_ROLES.has(n.role) && visible(n));
  const words = readable(nodes).find((n) => (n.role === "AXStaticText" || n.role === "AXHeading") && v.progress.test(n.words!.trim()));
  if (words) return words.words!;
  return bar ? `a ${bar.role === "AXBusyIndicator" ? "busy" : "progress"} indicator${bar.words ? ` (${bar.words})` : ""}` : null;
}

/**
 * A progress or busy indicator on screen anywhere in the page's web area, for a page that shows one beside its main landmark
 * rather than in it: a sign-in form's "Please wait" bar that sits next to `<main>` while the account is checked (#2351).
 * Only an indicator counts here, not words: words outside the main pane are often the page's chrome.
 */
export function pageIndicator(s: Snapshot): string | null {
  const win = mainWindow(s);
  if (!win) return null;
  const web = win.nodes.filter((n) => n.role === "AXWebArea" && visible(n)).sort((a, b) => b.w! * b.h! - a.w! * a.h!)[0];
  if (!web) return null;
  const onScreen = (n: AxNode) => {
    const r = rectOf(n);
    return r.x < win.x + win.w && r.x + r.w > win.x && r.y < win.y + win.h && r.y + r.h > win.y;
  };
  const bar = subtree(win.nodes, web.i).find((n) => PROGRESS_ROLES.has(n.role) && visible(n) && onScreen(n));
  return bar ? `a ${bar.role === "AXBusyIndicator" ? "busy" : "progress"} indicator${bar.words ? ` (${bar.words})` : ""}` : null;
}

/**
 * The app's own view, outside the page's web content, saying something is under way: a start view that shows "Signing
 * in…" while the page under it is still drawing. It applies when the pane is the page (a main landmark or a web area),
 * since a dialog's pane, or a window with no web area, takes in the whole view already. Gone once that view is gone, so a page
 * still blank after it fails.
 * @claim "It applies when the pane is the page" scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the judges > a blank page under the app's own view that says it's signing in is in progress; once that view is gone, or the window is one shade, it's blank and a dead end) verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the judges > a progress bar beside the main landmark, as a sign-in form shows while it checks an account, keeps a page from being a dead end, and without it the page is one (#2351))
 */
export function appViewProgress(s: Snapshot, p: Pane, v: Vocabulary): string | null {
  const win = mainWindow(s);
  if (!win || (p.kind !== "main" && p.kind !== "web")) return null;
  const web = new Set(win.nodes.filter((n) => n.role === "AXWebArea").flatMap((n) => subtree(win.nodes, n.i)));
  // With no web content there is no page under a view: a native pane's neighbours are its chrome (#2351).
  if (web.size === 0) return null;
  return progressOf(
    win.nodes.filter((n) => !web.has(n)),
    v,
  );
}

export type Verdict = { ok: boolean; evidence: string };

/**
 * No blank screen: the pane shows something to read, or a named progress state, and its pixels aren't one shade.
 * @claim "No blank screen: the pane shows" scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the judges > the blank main a dismissed loading dialog left is blank and a dead end, naming the controls it offers) verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the judges > words over a pane of one shade are still blank, but a sparse page is not)
 */
export function judgeNotBlank(s: Snapshot, v: Vocabulary = DEFAULT_VOCABULARY): Verdict & { progress: string | null } {
  const p = pane(s);
  if (p.kind === "none") return { ok: false, evidence: "no window on screen", progress: null };
  const content = readable(p.nodes);
  const progress = progressOf(p.nodes, v);
  const flat = s.pixels && s.pixels.uniform >= UNIFORM_BLANK;
  if (progress) return { ok: true, evidence: `${p.label} shows a progress state: ${progress.slice(0, 80)}`, progress };
  // A page still drawing under the app's own view, which says it's under way, is in progress, while the window shows more
  // than one shade.
  const own = flat ? null : appViewProgress(s, p, v);
  if (own) return { ok: true, evidence: `${p.label} is still drawing under the app's own view, which shows a progress state: ${own.slice(0, 80)}`, progress: own };
  if (content.length === 0) return { ok: false, evidence: `${p.label} shows nothing to read and no progress state${flat ? ", and draws one shade" : ""}`, progress };
  // One shade over a pane whose tree lists a word or two is a pane that drew nothing yet; a fuller tree is trusted over a
  // picture (a page still painting its card, a screenshot of a window the person can't see).
  if (flat && content.length <= THIN_TREE) return { ok: false, evidence: `${p.label} draws one shade (${Math.round(s.pixels!.uniform * 1000) / 10}% of it), and its tree lists only ${content.map((n) => `"${n.words!.slice(0, 30)}"`).join(", ")}`, progress };
  return { ok: true, evidence: `${p.label} shows ${content.length} items (${content.slice(0, 3).map((n) => n.words!.slice(0, 30)).join(" / ")})`, progress };
}

/** The enabled controls on screen that move the person forward, inside the topmost dialog when one is up (a modal hides the rest). */
export function forwardActions(s: Snapshot, v: Vocabulary = DEFAULT_VOCABULARY): string[] {
  const top = dialogs(s).at(-1);
  const scope = top ? top.nodes : (mainWindow(s)?.nodes ?? []);
  const words = (n: AxNode) => (n.words ?? "").split(" | ");
  return [...new Set(scope.filter((n) => PRESSABLE.has(n.role) && n.enabled && visible(n) && words(n).some((w) => v.forward.test(w.trim()))).map((n) => words(n).find((w) => v.forward.test(w.trim()))!))];
}

export type Place = "goal" | "forward" | "progress" | "dead-end";

/**
 * No dead end: the goal, or a way forward, or a named progress state (whose end the watch times).
 * @claim "No dead end: the goal, or" scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the judges > the goal is no dead end, whatever is on screen) verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the judges > a line saying the app is getting the chats is neither blank nor a dead end)
 */
export function judgeDeadEnd(s: Snapshot, o: { vocabulary?: Vocabulary; goal?: ((s: Snapshot) => boolean) | undefined } = {}): Verdict & { place: Place; forward: string[] } {
  const v = o.vocabulary ?? DEFAULT_VOCABULARY;
  if (o.goal?.(s)) return { ok: true, evidence: "the goal: signed in and synced", place: "goal", forward: [] };
  const forward = forwardActions(s, v);
  if (forward.length) return { ok: true, evidence: `the way forward: ${forward.slice(0, 4).join(", ")}`, place: "forward", forward };
  const p = pane(s);
  const flat = s.pixels && s.pixels.uniform >= UNIFORM_BLANK;
  const progress = progressOf(p.nodes, v) ?? (p.kind === "main" ? pageIndicator(s) : null) ?? (flat ? null : appViewProgress(s, p, v));
  if (progress) return { ok: true, evidence: `under way: ${progress.slice(0, 80)}`, place: "progress", forward };
  // Signed in, a card over the app with nothing of its own to press on (the account card the person opened, Settings) is
  // put away with Escape or a click beside it, and the app behind it is the way on, as the session's own advance treats it
  // (#2359). Signed out or unknown, a card with no way forward is still a dead end.
  const top = dialogs(s).at(-1);
  if (s.signedIn === true && top) return { ok: true, evidence: `signed in, a card over the app ("${dialogLabel(top.nodes)}"), put away with Escape`, place: "forward", forward };
  const offered = (mainWindow(s)?.nodes ?? []).filter((n) => PRESSABLE.has(n.role) && n.enabled && visible(n) && n.words).map((n) => n.words!.split(" | ")[0]!);
  return { ok: false, evidence: `a dead end: no enabled control moves the person forward and nothing is under way (the controls here: ${[...new Set(offered)].slice(0, 8).join(", ") || "none"})`, place: "dead-end", forward };
}

/**
 * Signed-out truth: while signed out, no on-screen words say what a signed-in person's empty screen says.
 * @claim "Signed-out truth: while signed out," scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the judges > signed out, an empty signed-in screen's words fail; signed in or unknown they pass)
 */
export function judgeSignedOut(s: Snapshot, v: Vocabulary = DEFAULT_VOCABULARY): Verdict {
  if (s.signedIn !== false) return { ok: true, evidence: s.signedIn ? "signed in" : "sign-in state unknown" };
  const lies = s.windows.flatMap((w) => w.nodes).filter((n) => visible(n) && n.words && v.emptyWhileSignedIn.test(n.words));
  return lies.length
    ? { ok: false, evidence: `signed out, yet the window says what a signed-in empty screen says: "${lies[0]!.words!.slice(0, 80)}"` }
    : { ok: true, evidence: "signed out, and nothing on screen claims an empty signed-in state" };
}

export type DismissMethod = "escape" | "close" | "outside";
export const DISMISS_METHODS: DismissMethod[] = ["escape", "close", "outside"];

/**
 * The dialog's own close control, if it has one: its words, for an accessibility press.
 * @claim "The dialog's own close control, if" scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the judges > the close control is the dialog's own enabled close button, by its words or its subrole)
 */
export function closeControl(nodes: AxNode[], v: Vocabulary = DEFAULT_VOCABULARY): string | null {
  const c = nodes.find((n) => PRESSABLE.has(n.role) && n.enabled && visible(n) && (n.subrole === "AXCloseButton" || (n.words ?? "").split(" | ").some((w) => v.close.test(w.trim()))));
  return c ? (c.words ?? "").split(" | ").find((w) => v.close.test(w.trim())) ?? c.words ?? null : null;
}

/** A point inside the window and outside the dialog, in the widest margin around it, clear of the window's top bar. */
export function outsidePoint(dialog: Rect, window: Rect, topBar = 60): { x: number; y: number } | null {
  const top = window.y + topBar;
  const gaps = [
    { room: dialog.x - window.x, x: (window.x + dialog.x) / 2, y: dialog.y + dialog.h / 2 },
    { room: window.x + window.w - (dialog.x + dialog.w), x: (dialog.x + dialog.w + window.x + window.w) / 2, y: dialog.y + dialog.h / 2 },
    { room: dialog.y - top, x: dialog.x + dialog.w / 2, y: (top + dialog.y) / 2 },
    { room: window.y + window.h - (dialog.y + dialog.h), x: dialog.x + dialog.w / 2, y: (dialog.y + dialog.h + window.y + window.h) / 2 },
  ].filter((g) => g.room >= 24).sort((a, b) => b.room - a.room);
  return gaps[0] ? { x: Math.round(gaps[0].x), y: Math.round(gaps[0].y) } : null;
}

/**
 * The state a dismissal left: the dialog held, or the state after passes every rule.
 * @claim "The state a dismissal left: the" scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the judges > a dismissal that left the dialog up, a blank dead end, or a progress state is judged by what it left)
 */
export function judgeAfterDismiss(before: string, after: Snapshot, o: { vocabulary?: Vocabulary; goal?: ((s: Snapshot) => boolean) | undefined; method: DismissMethod }): Verdict & { dismissed: boolean } {
  const v = o.vocabulary ?? DEFAULT_VOCABULARY;
  const still = dialogs(after).some((d) => dialogLabel(d.nodes) === before);
  if (still) return { ok: true, evidence: `${o.method} left "${before}" up`, dismissed: false };
  const problems = [judgeNotBlank(after, v), judgeDeadEnd(after, { vocabulary: v, goal: o.goal }), judgeSignedOut(after, v)].filter((x) => !x.ok).map((x) => x.evidence);
  return problems.length
    ? { ok: false, evidence: `${o.method} took "${before}" away, and what it left fails: ${problems.join("; ")}`, dismissed: true }
    : { ok: true, evidence: `${o.method} took "${before}" away, and what it left still offers the way: ${judgeDeadEnd(after, { vocabulary: v, goal: o.goal }).evidence}`, dismissed: true };
}

export type WatchConfig = {
  vocabulary?: Vocabulary;
  goal?: ((s: Snapshot) => boolean) | undefined;
  /**
   * How long a pane may show nothing (no content, no progress) before it fails.
   * @claim "How long a pane may show nothing" scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the state watch > a state blank past its limit fails once, and one blank in passing does not)
   */
  blankWithinMs?: number;
  /**
   * How long a progress state with no way forward may last before it is a dead end.
   * @claim "How long a progress state with no" scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the state watch > a progress state with no way forward past its limit is stuck)
   */
  progressWithinMs?: number;
  /** How long a state may stay a dead end before it fails: a page still loading in passing is not one. */
  deadEndWithinMs?: number;
  /** How long the signed-out lie may stay on screen before it fails: one read while a page swaps is not one. */
  signedOutWithinMs?: number;
};

export type StateRecord = { key: string; label: string; enteredAt: number; leftAt?: number; place: Place; notes: string[] };
export type Violation = { rule: "blank" | "dead-end" | "stuck" | "signed-out"; at: number; ms: number; state: string; evidence: string };

/**
 * Watches snapshot after snapshot and applies the rules with their fixed times: a state in passing (a frame between two
 * pages) is not judged, a state that stays is. Each distinct state is recorded with when it came and went.
 * @claim "Watches snapshot after snapshot and applies" scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the state watch > a state blank past its limit fails once, and one blank in passing does not)
 * @claim "Each distinct state is recorded with" scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the state watch > a state is named by its dialog, else its headings, else its pane, with where it stands)
 */
export class StateWatch {
  readonly states: StateRecord[] = [];
  readonly violations: Violation[] = [];
  private cfg: Required<Omit<WatchConfig, "goal">> & { goal?: ((s: Snapshot) => boolean) | undefined };
  private since: Record<Violation["rule"], { at: number; evidence: string; reported: boolean } | null> = { blank: null, "dead-end": null, stuck: null, "signed-out": null };
  constructor(cfg: WatchConfig = {}) {
    this.cfg = {
      vocabulary: cfg.vocabulary ?? DEFAULT_VOCABULARY,
      blankWithinMs: cfg.blankWithinMs ?? 5000,
      progressWithinMs: cfg.progressWithinMs ?? 90_000,
      deadEndWithinMs: cfg.deadEndWithinMs ?? 10_000,
      signedOutWithinMs: cfg.signedOutWithinMs ?? 2500,
      goal: cfg.goal,
    };
  }

  /** The state's name: the pane, its dialog or headings, where it stands (goal, way forward, under way, dead end) and its ways forward. */
  key(s: Snapshot): { key: string; label: string } {
    const p = pane(s);
    const heads = p.nodes.filter((n) => n.role === "AXHeading" && n.words && visible(n)).map((n) => n.words!).slice(0, 3);
    const label = p.kind === "dialog" ? `dialog "${p.label}"` : heads.length ? heads.join(" / ") : p.label;
    const place = judgeDeadEnd(s, { vocabulary: this.cfg.vocabulary, goal: this.cfg.goal }).place;
    return { key: `${p.kind}|${label}|${place}|${forwardActions(s, this.cfg.vocabulary).join(",")}`, label };
  }

  /** Judges one snapshot; returns the violations it completed. */
  observe(s: Snapshot): Violation[] {
    const { key, label } = this.key(s);
    const last = this.states.at(-1);
    const blank = judgeNotBlank(s, this.cfg.vocabulary);
    const dead = judgeDeadEnd(s, { vocabulary: this.cfg.vocabulary, goal: this.cfg.goal });
    const truth = judgeSignedOut(s, this.cfg.vocabulary);
    if (!last || last.key !== key) {
      if (last) last.leftAt = s.at;
      this.states.push({ key, label, enteredAt: s.at, place: dead.place, notes: [blank.evidence, dead.evidence, ...(truth.ok ? [] : [truth.evidence])] });
    }
    const done: Violation[] = [];
    const track = (rule: Violation["rule"], failing: boolean, evidence: string, limit: number) => {
      if (!failing) {
        this.since[rule] = null;
        return;
      }
      const run = (this.since[rule] ??= { at: s.at, evidence, reported: false });
      run.evidence = evidence;
      if (!run.reported && s.at - run.at >= limit) {
        run.reported = true;
        const v: Violation = { rule, at: run.at, ms: s.at - run.at, state: label, evidence };
        this.violations.push(v);
        done.push(v);
      }
    };
    track("blank", !blank.ok, blank.evidence, this.cfg.blankWithinMs);
    track("dead-end", dead.place === "dead-end", dead.evidence, this.cfg.deadEndWithinMs);
    track("stuck", dead.place === "progress", `still under way with no way forward: ${dead.evidence}`, this.cfg.progressWithinMs);
    track("signed-out", !truth.ok, truth.evidence, this.cfg.signedOutWithinMs);
    return done;
  }

  /**
   * No window to judge (the app quit, or is being replaced): what was running ends here, and nothing carries over.
   * @claim "No window to judge (the app quit," scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the state watch > a gap carries nothing over, and two gaps in a row are one gap state)
   */
  gap(at: number): void {
    const last = this.states.at(-1);
    this.since = { blank: null, "dead-end": null, stuck: null, "signed-out": null };
    if (last?.key === "gap") return;
    if (last && last.leftAt === undefined) last.leftAt = at;
    this.states.push({ key: "gap", label: "no window", enteredAt: at, place: "progress", notes: [] });
  }

  /**
   * Each state with how long it lasted, for the report.
   * @claim "Each state with how long it lasted," scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the state watch > a gap carries nothing over, and two gaps in a row are one gap state)
   */
  timeline(now: number): { label: string; place: Place; at: number; ms: number }[] {
    return this.states.map((st) => ({ label: st.label, place: st.place, at: st.enteredAt, ms: (st.leftAt ?? now) - st.enteredAt }));
  }
}

/**
 * A step's time against its fixed limit: the gate's timings, each with the bar it was held to.
 * @claim "A step's time against its fixed" scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the judges > a step's time is held to its limit)
 */
export type Timed = { step: string; ms: number; limitMs: number; ok: boolean };
export function timed(step: string, ms: number, limitMs: number): Timed {
  return { step, ms, limitMs, ok: ms <= limitMs };
}
