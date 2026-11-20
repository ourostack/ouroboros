import fs from "node:fs";
import path from "node:path";
import { snapshot, treeText, type Eyes } from "./first-run-eyes.ts";
import {
  StateWatch,
  closeControl,
  dialogLabel,
  dialogs,
  forwardActions,
  judgeAfterDismiss,
  judgeDeadEnd,
  judgeNotBlank,
  judgeSignedOut,
  longestBlank,
  mainRect,
  mainWindow,
  outsidePoint,
  timed,
  type DismissMethod,
  type Snapshot,
  type Timed,
  type Vocabulary,
  type Violation,
} from "./first-run-judges.ts";
import { unreachable, type Block, type Network } from "./first-run-network.ts";
import { system, type System } from "./first-run-system.ts";
import type { Detour } from "./first-run-detours.ts";

// First-run harness: a scripted session from a fresh install to signed in and synced, judged at every look. Generic: the
// app hands it an AppConfig (its words, its steps, its sign-in, its controls) and a Report (where its steps go); the
// session drives the path, runs the detours (first-run-detours.ts), applies the rules (first-run-judges.ts) with their
// fixed times, and keeps a picture and an accessibility dump of each state and each failure.

/** Where the session's findings go: the app's own report. `at` is the session's clock, in ms, which its readings share. */
export type Report = { step(name: string, ok: boolean, evidence: string): void; note(event: string, detail?: unknown): void; log(msg: string): void; at(): number };

/** Something a person can do: a key, a toolbar button, a menu. */
export type Control = { name: string; act: () => Promise<unknown> };

export type AppConfig = {
  vocabulary: Vocabulary;
  /** The installed app, as a person opens it from the Dock. */
  bundle: string;
  /** Its process name, to find it before its window opens. */
  processName: string;
  /** The process that owns the main window, or a falsy id while the window is closed. */
  pid(): Promise<number>;
  /** Whether the person is signed in, by the app's own answer; null while it can't say. */
  signedIn(): Promise<boolean | null>;
  /** Whether the app holds what a signed-in person expects (its data synced); read whenever the session looks, so keep it cheap. */
  synced(): boolean;
  /** The app's name for where the path is (its sign-in pages, its welcome); the session names the goal "synced". */
  checkpoint(s: Snapshot): string;
  /** Checkpoints before the sign-in finishes. */
  beforeSignIn(cp: string): boolean;
  /** Checkpoints on the identity provider's own pages. */
  signInPage(cp: string): boolean;
  /** One step along the path from here: the identity provider's page answered as the test account, or the app's way forward pressed. */
  advance(s: Snapshot, o: { staySignedIn: boolean; pressed: Map<string, number> }): Promise<void>;
  /** Opens the app as a person does, answering the system's first-open question; true once its window is up. */
  open(): Promise<boolean>;
  /** Quits it as its menu does; true once it and its helpers are gone. */
  quit(): Promise<boolean>;
  /** Brings it to the front, so a key goes to it. */
  activate(): void;
  /** The controls a person can reach before the sign-in finishes. */
  controls: Control[];
  /** The controls that show the app's spaces, for the signed-out checks. */
  spaces: Control[];
  /** The account button's label ("Account", or a prefix ending in *). */
  accountButton?: string;
  /** The menu bar item's index among the app's own, if it has one. */
  menuBarItem?: number;
  /** Signs the person out as they would (or as a lapsed sign-in is); says how, "" if it couldn't. */
  signOut?(): Promise<string>;
  /** Presses the app's own ask for a permission, if one is offered here; says which, or null. */
  askPermission?(s: Snapshot): Promise<string | null>;
  /** The sign-in's network, refused while the signed-out window is judged (network.ts unreachable). */
  signInNetwork: Network;
  /**
   * The hosts and ranges the app reaches, refused for the offline detour. Without it the whole machine goes offline, which a CI
   * runner can't afford: its own connection to its service goes too.
   * @claim "Without it the whole machine goes offline" scripts/check/first-run-session.test.mts verify:testExists(scripts/check/first-run-session.test.mts::first-run harness: the detours > offline: holds everything the app reaches, or the whole machine, judges the window, then lets the network back)
   */
  network?: Network;
  /**
   * Where the app reads its data from, not its sign-in. In a dismiss detour it is held unreachable from the moment the
   * person is signed in until the first dialog's dismissal is judged, so what a dismissal leaves while the data is still
   * coming is read every time, not only when a fast sync loses the race.
   * @claim "In a dismiss detour it is held" scripts/check/first-run-session.test.mts verify:testExists(scripts/check/first-run-session.test.mts::first-run harness: dialogs pushed away > holds the sync from signed in until the first dismissal is judged, once, and lets it go when no dialog comes)
   */
  syncNetwork?: Network;
  /** The checkpoint at which the sync is held: the sign-in's last page, before the data starts (by default, once signed in). */
  holdSyncAt?(cp: string): boolean;
  /** Controls that cancel the identity provider's page (besides Escape). */
  cancelSignIn?: string[];
  /** Words on a control that declines a question, such as Cancel, Not now or Skip. */
  decline?: RegExp;
  /** The menu bar item's entry that opens the window. */
  reopen?: RegExp;
};

/**
 * The fixed times, in ms. Each phase over its limit fails, naming the limit.
 * @claim "Each phase over its limit fails" scripts/check/first-run-session.test.mts verify:testExists(scripts/check/first-run-session.test.mts::first-run harness: a detour's whole session, and the report > reports each rule the watch caught, with its first time, and each timing over its limit)
 */
export const LIMITS = {
  blankWithinMs: 5000,
  deadEndWithinMs: 10_000,
  signedOutWithinMs: 2500,
  progressWithinMs: 90_000,
  /** After a dismissal, how long the page behind is read (its pixels, fast) before the state it left is judged. */
  dismissWatchMs: 3000,
  /** The longest the page behind a dismissed dialog may be one shade: the repository's bar for a first launch's blank window. */
  dismissBlankMs: 500,
  /**
   * The longest the sync is held for a dismissal (when no dialog comes, it is let go).
   * @claim "The longest the sync is held" scripts/check/first-run-session.test.mts verify:testExists(scripts/check/first-run-session.test.mts::first-run harness: dialogs pushed away > holds the sync from signed in until the first dismissal is judged, once, and lets it go when no dialog comes)
   */
  syncHoldMs: 30_000,
  /** Signed in, to signed in and synced. */
  syncedMs: 150_000,
  /** A detour's whole path, its detours included. */
  detourMs: 480_000,
  /** Sign out, to signed out by the app's own answer. */
  signOutMs: 20_000,
  /** A signed-out space, to showing it honestly with a way in (the window learns it is signed out). */
  strandedSettleMs: 12_000,
  /** The account button or the menu bar item, to a way to sign in. */
  leadsMs: 8000,
  /** Offline from the first open, before the network comes back. */
  offlineMs: 25_000,
};
export type Limits = typeof LIMITS;

const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "state";
// Read only where the main window is up.
const headings = (s: Snapshot) => mainWindow(s)!.nodes.filter((n) => n.role === "AXHeading" && n.words).map((n) => n.words!);
const secs = (ms: number) => Math.round(ms / 100) / 10;

export class FirstRunSession {
  readonly watch: StateWatch;
  readonly timings: Timed[] = [];
  readonly dismissals: { method: DismissMethod; dialog: string; ok: boolean; dismissed: boolean; evidence: string; ms: number }[] = [];
  readonly limits: Limits;
  last: Snapshot | null = null;
  /** The session itself has something open that isn't on the person's path (an account card to sign out): not judged. */
  quiet = false;
  dismiss: DismissMethod | null = null;
  /** When a detour first acted (quit, closed the window, pressed a control): what follows isn't the first launch's own. */
  interruptedAt: number | null = null;
  private dir: string;
  private probed = new Set<string>();
  private held: { block: Block; at: number } | null = null;
  private heldOnce = false;
  private lastLook = -1e9;
  private n = { states: 0, fails: 0, kept: 0 };
  readonly app: AppConfig;
  readonly eyes: Eyes;
  /**
   * The app's report, through which the session counts each step that failed, its detours' too.
   * @claim "The app's report, through which the" scripts/check/first-run-session.test.mts verify:testExists(scripts/check/first-run-session.test.mts::first-run harness: the session's path to signed in and synced > fails a path that never reaches synced within its limit, naming where it stopped)
   */
  readonly report: Report;
  /** The steps that failed, by name. */
  readonly failed: string[] = [];
  /** The machine the session runs on: commands, the Dock's open, and waiting. */
  readonly sys: System;
  constructor(o: { out: string; eyes: Eyes; app: AppConfig; report: Report; limits?: Partial<Limits>; system?: System }) {
    this.sys = o.system ?? system;
    this.app = o.app;
    this.eyes = o.eyes;
    this.report = {
      step: (name, ok, evidence) => {
        if (!ok) this.failed.push(name);
        o.report.step(name, ok, evidence);
      },
      note: (event, detail) => o.report.note(event, detail),
      log: (msg) => o.report.log(msg),
      at: () => o.report.at(),
    };
    this.limits = { ...LIMITS, ...o.limits };
    this.dir = path.join(o.out, "gate");
    fs.mkdirSync(path.join(this.dir, "states"), { recursive: true });
    this.watch = new StateWatch({ vocabulary: o.app.vocabulary, goal: (s) => this.inApp(s), ...this.limits });
  }
  private get v() {
    return this.app.vocabulary;
  }
  private step(name: string, ok: boolean, evidence: string) {
    this.report.step(name, ok, evidence);
  }

  /**
   * In the app: signed in, no dialog up, the pane showing something. Not a dead end, whatever it offers.
   * @claim "In the app: signed in, no dialog up" scripts/check/first-run-session.test.mts verify:testExists(scripts/check/first-run-session.test.mts::first-run harness: what an action left > passes once the state passes every rule, and keeps it)
   */
  inApp(s: Snapshot): boolean {
    return s.signedIn === true && dialogs(s).length === 0 && judgeNotBlank(s, this.v).ok;
  }
  /** The goal: in the app, and synced by the app's own answer. */
  goal(s: Snapshot): boolean {
    return this.inApp(s) && this.app.synced();
  }
  checkpoint(s: Snapshot): string {
    return this.goal(s) ? "synced" : this.app.checkpoint(s);
  }

  /** One look, judged: the window's tree, a screenshot and its pane's pixels, and whether the person is signed in. */
  async look(why = ""): Promise<Snapshot | null> {
    const pid = await this.app.pid();
    if (!pid || !(await this.eyes.shown(pid))) {
      this.watch.gap(this.report.at());
      return null;
    }
    const shot = path.join(this.dir, "now.png");
    const s = await snapshot(this.eyes, pid, { at: this.report.at, signedIn: () => this.app.signedIn(), shot, sys: this.sys });
    this.lastLook = this.report.at();
    this.last = s;
    if (!mainWindow(s)) {
      this.watch.gap(this.report.at());
      return s;
    }
    if (this.dismiss && this.app.syncNetwork && !this.heldOnce && mainWindow(s) && (this.app.holdSyncAt ? this.app.holdSyncAt(this.app.checkpoint(s)) : s.signedIn === true)) this.holdSync();
    if (this.held && this.report.at() - this.held.at > this.limits.syncHoldMs) this.releaseSync("no dialog came to dismiss");
    if (this.quiet) return s;
    const before = this.watch.states.length;
    const done = this.watch.observe(s);
    if (this.watch.states.length > before) this.keep(`states/${String(++this.n.states).padStart(2, "0")}-${slug(this.watch.states.at(-1)!.label)}`, s, why);
    for (const v of done) {
      this.keep(`fail-${String(++this.n.fails).padStart(2, "0")}-${v.rule}`, s, `${v.rule}: ${v.evidence}`);
      this.report.log(`gate: ${v.rule} — ${v.evidence} (state "${v.state}", ${secs(v.ms)} s from ${secs(v.at)} s)`);
    }
    return s;
  }
  /** Holds the app's data back (syncNetwork), once, from the moment the person is signed in. */
  private holdSync() {
    this.heldOnce = true;
    // Hung, not refused: a refusal is an answer (an honest "can't reach it"); a sync still on its way is what a dialog hides.
    const block = unreachable(this.app.syncNetwork!, "the sync held, its requests left hanging", "hang", this.sys);
    this.held = { block, at: this.report.at() };
    this.step("sync-held", block.ok, `${block.evidence} before the data starts, so the first dialog is dismissed while it is still coming`);
  }
  private releaseSync(why: string) {
    if (!this.held) return;
    this.held.block.lift();
    this.held = null;
    this.report.note("sync released", why);
  }

  /**
   * A look at most every `gapMs`, and in a dismiss detour, each new dialog pushed away: for an app's own loop to call often.
   * @claim "A look at most every `gapMs`" scripts/check/first-run-session.test.mts verify:testExists(scripts/check/first-run-session.test.mts::first-run harness: the session's path to signed in and synced > judges nothing while quiet, and only looks again after its gap)
   */
  async observe(gapMs = 1500): Promise<void> {
    if (this.report.at() - this.lastLook < gapMs) return;
    const s = await this.look();
    if (s && this.dismiss) await this.probe(s);
  }
  /** The picture, the tree (role, words, frame, DOM id and classes) and what was judged, side by side. */
  keep(name: string, s: Snapshot, why: string) {
    const base = path.join(this.dir, name);
    const shot = path.join(this.dir, "now.png");
    if (fs.existsSync(shot)) fs.copyFileSync(shot, `${base}.png`);
    const judged = [judgeNotBlank(s, this.v), judgeDeadEnd(s, { vocabulary: this.v, goal: (x) => this.inApp(x) }), judgeSignedOut(s, this.v)].map((x) => `${x.ok ? "ok  " : "FAIL"} ${x.evidence}`);
    fs.writeFileSync(`${base}.txt`, `${why ? `${why}\n` : ""}signed in: ${s.signedIn}; synced: ${this.app.synced()}; pixels: ${JSON.stringify(s.pixels ?? null)}\n${judged.join("\n")}\n\n${treeText(s.windows)}`);
  }

  /** Pushes the topmost dialog away once (Escape, its close control, a click outside it) and judges the state it left. */
  async probe(s: Snapshot, method = this.dismiss): Promise<void> {
    const top = dialogs(s).at(-1);
    if (!method || !top) return;
    const label = dialogLabel(top.nodes);
    if (this.probed.has(`${method}|${label}`)) return;
    this.probed.add(`${method}|${label}`);
    const pid = await this.app.pid();
    const win = mainWindow(s);
    const behind = mainRect(s);
    if (method === "escape") this.app.activate();
    const t0 = this.report.at();
    const name = `dismiss-${method}-${this.dismissals.length + 1}`;
    let how: string;
    if (method === "escape") {
      await this.eyes.key("escape");
      how = "Escape";
    } else if (method === "close") {
      const c = closeControl(top.nodes, this.v);
      if (!c) {
        this.dismissals.push({ method, dialog: label, ok: true, dismissed: false, evidence: "no close control", ms: 0 });
        return this.step(name, true, `"${label}" has no close control to press`);
      }
      how = `its "${c}" button`;
      await this.eyes.press(pid, c);
    } else {
      // A dialog on screen has a size (judges' `visible`); only its place can be missing.
      // An alert with no main window behind it has nowhere outside it to click, as one that fills the window has.
      const p = win ? outsidePoint({ x: top.node.x ?? 0, y: top.node.y ?? 0, w: top.node.w!, h: top.node.h! }, win) : null;
      if (!p) {
        const why = win ? "fills the window" : "has no window behind it";
        this.dismissals.push({ method, dialog: label, ok: true, dismissed: false, evidence: why, ms: 0 });
        return this.step(name, true, `"${label}" ${why}, so there is nowhere outside it to click`);
      }
      how = `a click outside it at ${p.x},${p.y}`;
      await this.eyes.click(p.x, p.y);
    }
    // What the page behind shows, read from its pixels as fast as the screen can be captured while the dialog goes and
    // after, then the tree: a blank that lasts a second between two reads of the tree is still read, every time.
    const reads = behind ? await this.eyes.sample(behind, this.limits.dismissWatchMs, this.report.at, path.join(this.dir, "sample.png")) : [];
    const after = await this.look(`after ${how} on "${label}"`);
    let verdict = { ok: true, evidence: `${method} left "${label}" up`, dismissed: false };
    if (after && !dialogs(after).some((d) => dialogLabel(d.nodes) === label)) {
      verdict = judgeAfterDismiss(label, after, { vocabulary: this.v, goal: (x) => this.inApp(x), method });
      const blank = longestBlank(reads);
      if (blank.ms > this.limits.dismissBlankMs) {
        verdict = { ok: false, dismissed: true, evidence: `${method} took "${label}" away onto a blank pane: the page behind it was one shade for ${blank.ms} ms (the bar is ${this.limits.dismissBlankMs} ms), from ${secs(blank.at - t0)} s after ${how}${verdict.ok ? "" : `; then ${verdict.evidence.replace(/^.*?what it left fails: /, "")}`}` };
      }
    }
    this.releaseSync(`"${label}" judged`);
    this.dismissals.push({ method, dialog: label, ok: verdict.ok, dismissed: verdict.dismissed, evidence: verdict.evidence, ms: this.report.at() - t0 });
    if (after && mainWindow(after)) this.keep(`${name}-${verdict.ok ? "ok" : "FAIL"}`, after, `${verdict.evidence}\npixel reads of the page behind (ms after ${how}, share of one shade): ${reads.map((r) => `${r.at - t0}:${Math.round(r.uniform * 10000) / 10000}`).join(" ")}`);
    this.step(name, verdict.ok, `${how} on "${label}": ${verdict.evidence}${reads.length ? ` (${reads.length} pixel reads over ${this.limits.dismissWatchMs / 1000} s)` : ""}`);
  }

  /**
   * From wherever the app is to signed in and synced, as a person gets there (the app's `advance`). `detour`: called once
   * at the first arrival at each checkpoint, before the path goes on. With no window, the Dock opens it again.
   * @claim "`detour`: called once at the first" scripts/check/first-run-session.test.mts verify:testExists(scripts/check/first-run-session.test.mts::first-run harness: the session's path to signed in and synced > calls the detour once at the first arrival at each checkpoint, before the path goes on)
   * @claim "With no window, the Dock opens it again." scripts/check/first-run-session.test.mts verify:testExists(scripts/check/first-run-session.test.mts::first-run harness: the session's path to signed in and synced > opens the app from the Dock while it has no window, at most every 10 s)
   */
  async toGoal(phase: string, o: { limitMs?: number; staySignedIn?: boolean; detour?: ((cp: string, s: Snapshot) => Promise<void>) | undefined } = {}): Promise<boolean> {
    const limitMs = o.limitMs ?? this.limits.syncedMs;
    const t0 = this.report.at();
    const pressed = new Map<string, number>();
    const visited = new Set<string>();
    let last = "";
    while (this.report.at() - t0 < limitMs) {
      const s = await this.look(phase);
      if (s && this.dismiss) await this.probe(s);
      if (!s || !mainWindow(s)) {
        if (this.report.at() - (pressed.get("open") ?? -1e9) > 10_000) {
          pressed.set("open", this.report.at());
          this.sys.start("open", [this.app.bundle]);
        }
        await this.sys.sleep(800);
        continue;
      }
      const cp = this.checkpoint(s);
      if (o.detour && !visited.has(cp)) {
        visited.add(cp);
        this.report.note(`${phase}: checkpoint`, cp);
        await o.detour(cp, s);
        continue;
      }
      if (cp === "synced") {
        this.timings.push(timed(phase, this.report.at() - t0, limitMs));
        this.step(phase, true, `signed in and synced ${secs(this.report.at() - t0)} s after it began (the limit is ${limitMs / 1000} s)`);
        return true;
      }
      last = `${cp}; ${headings(s).join(" | ") || "no heading"}; ways forward: ${forwardActions(s, this.v).join(", ") || "none"}`;
      await this.app.advance(s, { staySignedIn: o.staySignedIn ?? true, pressed });
      await this.sys.sleep(900);
    }
    this.timings.push(timed(phase, this.report.at() - t0, limitMs));
    this.step(phase, false, `not signed in and synced within ${limitMs / 1000} s (signed in: ${this.last?.signedIn ?? "unknown"}; synced: ${this.app.synced()}); last: ${last}`);
    return false;
  }

  /**
   * What an action left, read until it passes or `settleMs`: something to read, a way forward or the goal, no signed-out lie.
   * @claim "What an action left, read until it passes" scripts/check/first-run-session.test.mts verify:testExists(scripts/check/first-run-session.test.mts::first-run harness: what an action left > fails a state that keeps failing, and a window that never came up)
   */
  async judgeAfter(name: string, what: string, settleMs = this.limits.blankWithinMs): Promise<boolean> {
    const t0 = this.report.at();
    let s: Snapshot | null = null;
    let bad = ["no window came up"];
    while (this.report.at() - t0 < settleMs) {
      await this.sys.sleep(700);
      s = await this.look(`after ${what}`);
      if (!s || !mainWindow(s)) continue;
      bad = [judgeNotBlank(s, this.v), judgeDeadEnd(s, { vocabulary: this.v, goal: (x) => this.inApp(x) }), judgeSignedOut(s, this.v)].filter((x) => !x.ok).map((x) => x.evidence);
      if (!bad.length) break;
    }
    const ok = bad.length === 0;
    if (s && mainWindow(s)) this.keep(`detour-${String(++this.n.kept).padStart(2, "0")}-${slug(name)}-${ok ? "ok" : "FAIL"}`, s, what);
    const where = s && mainWindow(s) ? this.watch.key(s).label : "no window";
    this.step(name, ok, ok ? `${what}: it left "${where}", ${judgeDeadEnd(s!, { vocabulary: this.v, goal: (x) => this.inApp(x) }).evidence}` : `${what}: ${bad.join("; ")} (${secs(settleMs)} s after; the window: "${where}")`);
    return ok;
  }

  /** The app's process, with or without a window. */
  processPid(): number {
    return Number(this.sys.run("pgrep", ["-x", this.app.processName]).stdout.trim().split("\n")[0] || 0);
  }

  /**
   * Signed out, the app must still be honest and offer the way in: each space shows something, a way forward and no
   * signed-in empty state; the menu bar item offers sign-in or opens a window that does; the account button leads to it.
   * @claim "Signed out, the app must still be honest" scripts/check/first-run-session.test.mts verify:testExists(scripts/check/first-run-session.test.mts::first-run harness: signed out > judges each space, the menu bar item and the account button while signed out)
   */
  async stranded(phase: string, o: { signIn: boolean } = { signIn: true }): Promise<void> {
    // Signed out, the way forward is a way to sign in; offline, any way forward (Try Again) is one.
    const leads = (w: string) => (o.signIn ? /^Sign in/i.test(w) : true);
    let windowOffers = false;
    for (const space of this.app.spaces) {
      this.app.activate();
      await space.act();
      let s: Snapshot | null = null;
      const t1 = this.report.at();
      let verdicts: { ok: boolean; evidence: string }[] = [];
      while (this.report.at() - t1 < this.limits.strandedSettleMs) {
        await this.sys.sleep(800);
        s = await this.look(`${phase}, ${space.name}`);
        if (!s || !mainWindow(s)) continue;
        verdicts = [judgeNotBlank(s, this.v), judgeDeadEnd(s, { vocabulary: this.v }), judgeSignedOut({ ...s, signedIn: s.signedIn ?? false }, this.v)];
        if (verdicts.every((x) => x.ok)) break;
      }
      const onPage = !!s && mainWindow(s) !== null && this.app.signInPage(this.app.checkpoint(s));
      windowOffers ||= onPage || (!!s && forwardActions(s, this.v).some(leads));
      const bad = verdicts.filter((x) => !x.ok);
      this.step(`${phase}-${slug(space.name).toLowerCase()}`, !!s && verdicts.length > 0 && bad.length === 0, !s || !verdicts.length ? "no window to read" : `${space.name}: ${(bad.length ? bad : verdicts).map((x) => x.evidence).join("; ")}`);
      if (onPage) break;
    }
    await this.menuBarLeads(phase, windowOffers);
    await this.accountLeads(phase, o.signIn);
  }

  private async menuBarLeads(phase: string, windowOffers: boolean): Promise<void> {
    if (this.app.menuBarItem === undefined) return;
    const menu = await this.eyes.extraMenu(this.processPid(), this.app.menuBarItem);
    await this.eyes.key("escape");
    const items = menu.items.map((i) => `${i.title}${i.enabled ? "" : " (disabled)"}`).filter((t) => t.trim());
    if (!menu.ok) return this.step(`${phase}-menu-bar`, false, `the menu bar item's menu didn't open when pressed (${menu.why ?? "no menu appeared under it within 2 s"}), so nothing there leads to sign-in`);
    const signIn = menu.items.find((i) => i.enabled && /Sign in/i.test(i.title));
    const open = menu.items.find((i) => i.enabled && (this.app.reopen ?? /^Open/).test(i.title));
    this.step(
      `${phase}-menu-bar`,
      !!signIn || (!!open && windowOffers),
      signIn ? `the menu bar item offers "${signIn.title}"` : open ? `the menu bar item offers no Sign in, only "${open.title}", to a window that ${windowOffers ? "offers Sign in" : "offers no way to sign in"} (its items: ${items.join(", ")})` : `the menu bar item offers no way to sign in (its items: ${items.join(", ")})`,
    );
  }

  private async accountLeads(phase: string, signIn: boolean): Promise<void> {
    if (!this.app.accountButton) return;
    const pid = await this.app.pid();
    this.app.activate();
    let before = await this.look(`${phase}, before the account button`);
    const onSignIn = (x: Snapshot | null) => !!x && mainWindow(x) !== null && this.app.signInPage(this.app.checkpoint(x));
    if (onSignIn(before)) return this.step(`${phase}-account`, true, "the window is already on the sign-in page, where the account button leads");
    // A window still starting, its own progress state up (a start cover's "Starting…" on a cold machine), hasn't drawn its
    // account button yet: it is pressed once that state is gone, within the progress limit gate-not-stuck holds a start to.
    const starting = (x: Snapshot | null) => (x && mainWindow(x) ? judgeNotBlank(x, this.v).progress : null);
    const t1 = this.report.at();
    const waited = starting(before);
    let pressed = (await this.eyes.press(pid, this.app.accountButton)).ok;
    while (!pressed && starting(before) && this.report.at() - t1 < this.limits.progressWithinMs) {
      await this.sys.sleep(1000);
      before = await this.look(`${phase}, before the account button`);
      if (onSignIn(before)) return this.step(`${phase}-account`, true, `the window is on the sign-in page, where the account button leads, after ${secs(this.report.at() - t1)} s of "${waited}"`);
      pressed = (await this.eyes.press(pid, this.app.accountButton)).ok;
    }
    const after = waited ? ` (after ${secs(this.report.at() - t1)} s of "${waited}"${starting(before) ? ", still under way" : ""})` : "";
    if (!pressed) return this.step(`${phase}-account`, false, `there was no enabled account button to press${after}`);
    const was = before ? this.watch.key(before).key : "";
    const offered = new Set(before ? forwardActions(before, this.v) : []);
    // Offline, a window that already offers its way forward (Try Again) isn't stranded by an account button that waits for it.
    const already = !signIn && offered.size > 0;
    const t0 = this.report.at();
    let s: Snapshot | null = null;
    let why = "";
    while (this.report.at() - t0 < this.limits.leadsMs && !why) {
      await this.sys.sleep(700);
      s = await this.look(`${phase}, after the account button`);
      if (!s || !mainWindow(s)) continue;
      const fresh = forwardActions(s, this.v).filter((w) => /^Sign in/i.test(w) && !offered.has(w));
      const trying = judgeNotBlank(s, this.v).progress;
      if (this.app.signInPage(this.app.checkpoint(s))) why = `led to the sign-in page ("${headings(s)[0] ?? ""}")`;
      else if (fresh.length) why = `led to ${fresh.map((w) => `"${w}"`).join(", ")}`;
      else if (trying && /sign/i.test(trying) && this.watch.key(s).key !== was) why = `started signing in: "${trying}"`;
    }
    if (!why && already) why = `waited, beside the window's own "${[...offered][0]}"`;
    this.step(`${phase}-account`, !!why, why ? `the account button ${why} in ${secs(this.report.at() - t0)} s` : s && this.watch.key(s).key === was ? `the account button did nothing: the window was the same ${this.limits.leadsMs / 1000} s later` : `the account button led nowhere to sign in within ${this.limits.leadsMs / 1000} s (the window: ${s && mainWindow(s) ? this.watch.key(s).label : "gone"})`);
    await this.eyes.key("escape");
  }

  /**
   * Signed out while the sign-in can't be renewed (its network refused, so nothing quietly signs back in mid-check), the
   * app judged as `stranded` says, then the network back and signed in and synced again.
   */
  async signedOutRound(staySignedIn = true): Promise<void> {
    const lapse = unreachable(this.app.signInNetwork, undefined, undefined, this.sys);
    this.step("sign-in-lapsed", lapse.ok, lapse.evidence);
    try {
      this.quiet = true;
      const how = this.app.signOut ? await this.app.signOut() : "";
      this.quiet = false;
      const t0 = this.report.at();
      let out = false;
      while (how && this.report.at() - t0 < this.limits.signOutMs && !out) {
        await this.sys.sleep(1000);
        out = (await this.app.signedIn()) === false;
      }
      this.timings.push(timed("sign-out", this.report.at() - t0, this.limits.signOutMs));
      this.step("signed-out", out, out ? `${how}; signed out ${secs(this.report.at() - t0)} s later` : how ? `${how}, yet still signed in ${this.limits.signOutMs / 1000} s later` : "no way to sign out");
      if (out) await this.stranded("signed-out");
    } finally {
      this.quiet = false;
      lapse.lift();
      this.report.note("sign-in network back");
    }
    await this.toGoal("signed-in-again", { staySignedIn });
  }

  /** A detour's whole session, from opening the app (detours.ts). */
  async run(d: Detour): Promise<void> {
    this.dismiss = d.dismiss ?? null;
    const lift = (await d.before?.(this)) ?? undefined;
    try {
      if (!(await this.app.open())) return;
      await d.start?.(this);
    } finally {
      lift?.();
    }
    await this.toGoal("synced", {
      limitMs: d.run ? this.limits.detourMs : this.limits.syncedMs,
      staySignedIn: d.staySignedIn ?? true,
      detour: d.run
        ? async (cp, s) => {
            if (!(d.at?.(cp, this.app) ?? true)) return;
            // What follows is the detour's own doing, not the first launch's.
            this.interruptedAt ??= this.report.at();
            await d.run!(this, cp, s);
          }
        : undefined,
    });
  }

  /**
   * The session's own checks from what the watch saw, and gate.json. True only when no step failed and the watch saw no violation.
   * @claim "True only when no step failed" scripts/check/first-run-session.test.mts verify:testExists(scripts/check/first-run-session.test.mts::first-run harness: the session's path to signed in and synced > fails a path that never reaches synced within its limit, naming where it stopped) verify:testExists(scripts/check/first-run-session.test.mts::first-run harness: a detour's whole session, and the report > reports each rule the watch caught, with its first time, and each timing over its limit)
   */
  finish(scenario: string): boolean {
    this.releaseSync("the session ended");
    const by = (rule: Violation["rule"]) => this.watch.violations.filter((x) => x.rule === rule);
    const say = (vs: Violation[], none: string) => (vs.length ? `${vs.length} time${vs.length > 1 ? "s" : ""}; first: ${vs[0]!.evidence}, for ${secs(vs[0]!.ms)} s from ${secs(vs[0]!.at)} s (state "${vs[0]!.state}")` : none);
    const states = this.watch.states.filter((x) => x.key !== "gap").length;
    this.step("gate-no-blank", by("blank").length === 0, say(by("blank"), `every pane showed something to read or a progress state within ${this.limits.blankWithinMs / 1000} s, over ${states} states`));
    this.step("gate-no-dead-end", by("dead-end").length === 0, say(by("dead-end"), `every state offered a way forward, was under way or was the goal, over ${states} states`));
    this.step("gate-not-stuck", by("stuck").length === 0, say(by("stuck"), `no progress state outlasted ${this.limits.progressWithinMs / 1000} s without a way forward`));
    this.step("gate-signed-out-truth", by("signed-out").length === 0, say(by("signed-out"), "while signed out, nothing claimed an empty signed-in state"));
    for (const t of this.timings.filter((x) => !x.ok)) this.step(`time-${t.step}`, false, `${t.step} took ${secs(t.ms)} s, over its ${t.limitMs / 1000} s limit`);
    fs.writeFileSync(path.join(this.dir, "gate.json"), JSON.stringify({ scenario, limits: this.limits, violations: this.watch.violations, dismissals: this.dismissals, timings: this.timings, states: this.watch.timeline(this.report.at()) }, null, 1));
    for (const f of ["now.png", "sample.png"]) fs.rmSync(path.join(this.dir, f), { force: true });
    this.eyes.stop();
    return this.failed.length === 0;
  }
}
