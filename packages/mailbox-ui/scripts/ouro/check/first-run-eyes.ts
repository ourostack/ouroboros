import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pane, type AxWindow, type Pixels, type Snapshot } from "./first-run-judges.ts";
import { system, type System } from "./first-run-system.ts";

// First-run harness: the eyes, a typed wrapper over first-run-ax-tree.swift's line protocol, and a snapshot that reads the
// app's windows, a screenshot of the screen and the pixels of the pane the person looks at. Generic: the app passes its
// process id and how to tell whether the person is signed in.

const SOURCE = path.join(import.meta.dirname, "first-run-ax-tree.swift");

/** Builds the eyes with swiftc at `out`, a path of the run's own outside the app; macOS only. */
export function buildEyes(out: string, sys: System = system): string {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = sys.run("swiftc", ["-O", SOURCE, "-o", out], { timeout: 300_000 });
  if (r.status !== 0) throw new Error(`first-run-ax-tree.swift did not build: ${(r.stderr || r.stdout).slice(0, 400)}`);
  return out;
}

type Answer = { ok: boolean; why?: string };

/** The eyes and hands: the built first-run-ax-tree.swift, asked one line at a time. */
export class Eyes {
  private proc: ChildProcess;
  private sys: System;
  private waiting: ((line: string) => void)[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private buffer = "";
  constructor(bin: string, sys: System = system) {
    this.sys = sys;
    this.proc = spawn(bin, [], { stdio: ["pipe", "pipe", "inherit"] });
    this.proc.stdout!.on("data", (d: Buffer) => {
      this.buffer += d;
      let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        this.waiting.shift()?.(line);
      }
    });
  }
  /**
   * One request at a time; an answer that doesn't come in `ms` is `{ ok: false }`, so a hung app can't hold the gate. The
   * eyes answer each line in turn, so a late answer goes to the request that timed out, which drops it.
   * @claim "The eyes answer each line in" scripts/check/first-run-units.test.mts verify:testExists(scripts/check/first-run-units.test.mts::first-run harness: the eyes > a request with no answer in time is no answer, and an answer that comes after it gave up is dropped) verify:fileLine(registry/ouro/check/first-run-ax-tree.swift, /say\(\["ok": false, "why": "unknown command"\]\)/)
   */
  ask<T = Answer>(line: string, ms = 30_000): Promise<T> {
    const turn = this.chain.then(
      () =>
        new Promise<T>((resolve) => {
          let settled = false;
          const timer = setTimeout(() => {
            settled = true;
            resolve({ ok: false, why: "no answer" } as T);
          }, ms);
          // Waited for only once the line is sent: a write that throws leaves no waiter to take another request's answer.
          this.proc.stdin!.write(`${line}\n`);
          this.waiting.push((l) => {
            clearTimeout(timer);
            if (!settled) resolve(JSON.parse(l) as T);
          });
        }),
    );
    this.chain = turn.catch(() => {});
    return turn;
  }
  async tree(pid: number): Promise<AxWindow[]> {
    return (await this.ask<{ windows?: AxWindow[] }>(`tree ${pid}`, 45_000)).windows ?? [];
  }
  /** Whether the process has a window a person can see (on screen, not transparent, not tiny). */
  async shown(pid: number): Promise<boolean> {
    return ((await this.ask<{ windows?: unknown[] }>(`shown ${pid}`)).windows ?? []).length > 0;
  }
  /** Presses the close button of the process's first window. */
  closeWindow(pid: number) {
    return this.ask(`close-window ${pid}`);
  }
  async extras(pid: number): Promise<string[]> {
    return (await this.ask<{ items?: string[] }>(`extras ${pid}`)).items ?? [];
  }
  /** Opens menu bar item `n` and reads its menu; the menu stays open until `extraPress` or `key("escape")`. */
  async extraMenu(pid: number, n = 0): Promise<{ ok: boolean; items: { title: string; enabled: boolean }[]; why?: string | undefined }> {
    const r = await this.ask<{ ok: boolean; items?: { title: string; enabled: boolean }[]; why?: string }>(`extra-menu ${pid} ${n}`);
    return { ok: r.ok, items: r.items ?? [], why: r.why };
  }
  extraPress(title: string) {
    return this.ask(`extra-press ${title}`);
  }
  press(pid: number, label: string) {
    return this.ask(`press ${pid} ${label}`);
  }
  /** escape, return, tab, or a letter or digit with modifiers: "cmd-w". */
  key(name: string) {
    return this.ask(`key ${name}`);
  }
  click(x: number, y: number) {
    return this.ask(`click ${Math.round(x)} ${Math.round(y)}`);
  }
  async pixels(png: string, r: { x: number; y: number; w: number; h: number }): Promise<Pixels | null> {
    const a = await this.ask<Answer & Partial<Pixels>>(`pixels ${png} ${Math.round(r.x)} ${Math.round(r.y)} ${Math.round(r.w)} ${Math.round(r.h)}`);
    return a.ok && typeof a.uniform === "number" ? { uniform: a.uniform, mean: a.mean ?? 0 } : null;
  }
  /**
   * The pane's pixels, read as fast as the screen can be captured, for `ms`: the time of a read and the share of the pane
   * in one shade, read by read, so a blank shorter than a look at the tree is read too.
   */
  async sample(rect: { x: number; y: number; w: number; h: number }, ms: number, at: () => number, file: string): Promise<{ at: number; uniform: number }[]> {
    const reads: { at: number; uniform: number }[] = [];
    const end = at() + ms;
    while (at() < end) {
      const t = at();
      this.sys.run("screencapture", ["-x", "-R", `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}`, file], { timeout: 10_000 });
      const p = await this.pixels(file, { x: 0, y: 0, w: 0, h: 0 });
      if (p) reads.push({ at: t, uniform: p.uniform });
    }
    return reads;
  }
  stop() {
    this.proc.kill();
  }
}

/**
 * One look at the app: its windows' trees, and, when `shot` names a file, a screenshot of the screen and the pixels of the
 * pane in it. `signedIn` is the app's own answer (null: unknown).
 */
export async function snapshot(eyes: Eyes, pid: number, o: { at: () => number; signedIn: () => Promise<boolean | null>; shot?: string; sys?: System }): Promise<Snapshot> {
  const at = o.at();
  const [windows, signedIn] = await Promise.all([pid ? eyes.tree(pid) : Promise.resolve([] as AxWindow[]), o.signedIn()]);
  const s: Snapshot = { at, windows, signedIn };
  if (o.shot) {
    (o.sys ?? system).run("screencapture", ["-x", o.shot], { timeout: 20_000 });
    const r = pane(s).rect;
    s.pixels = fs.existsSync(o.shot) && r.w > 0 ? await eyes.pixels(o.shot, r) : null;
  }
  return s;
}

/** The tree as lines a person can read: role, subrole, words, size and place, and the DOM id and classes where there are some. */
export function treeText(windows: AxWindow[]): string {
  return windows
    .map((w) => [`window "${w.title}" ${w.w}x${w.h}@${w.x},${w.y}`, ...w.nodes.map((n) => `${"  ".repeat(Math.min(n.d, 30))}${n.role}${n.subrole ? `/${n.subrole}` : ""}${n.enabled ? "" : " (disabled)"}${n.w !== undefined ? ` ${n.w}x${n.h}@${n.x},${n.y}` : ""}${n.domId ? ` #${n.domId}` : ""}${n.domClass?.length ? ` .${n.domClass.slice(0, 4).join(".")}` : ""}${n.words ? ` ${n.words.slice(0, 100)}` : ""}`)].join("\n"))
    .join("\n\n");
}
