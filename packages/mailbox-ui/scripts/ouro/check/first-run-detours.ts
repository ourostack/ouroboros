import type { DismissMethod, Snapshot } from "./first-run-judges.ts";
import { dialogs, forwardActions } from "./first-run-judges.ts";
import { offline, unreachable, type Block } from "./first-run-network.ts";
import type { AppConfig, FirstRunSession } from "./first-run-session.ts";

// First-run harness: the detours a person takes off the straight path, as data. Each is deterministic (a fixed list of
// actions at fixed checkpoints, never random clicking) and each must end signed in, or with one obvious way forward, with
// no blank screen, no dead end and no signed-out empty state on the way (first-run-session.ts judges every look). An app
// runs them all, or extends the list: `[...DETOURS, { id: "my-detour", … }]`.

export type Detour = {
  id: string;
  /** What a person did, for the report. */
  title: string;
  /**
   * Every dialog on the path pushed away this way, once each.
   * @claim "Every dialog on the path pushed away" scripts/check/first-run-session.test.mts verify:testExists(scripts/check/first-run-session.test.mts::first-run harness: dialogs pushed away > pushes each new dialog away once with Escape and judges what it left: the way forward behind it passes)
   */
  dismiss?: DismissMethod;
  /** How the identity provider's "stay signed in?" is answered (yes by default). */
  staySignedIn?: boolean;
  /** Before the app opens (the network, say); returns what undoes it. */
  before?(s: FirstRunSession): Promise<(() => void) | void>;
  /** Once the window is up, before the path goes on (and before `before` is undone). */
  start?(s: FirstRunSession): Promise<void>;
  /**
   * Which checkpoints `run` happens at (all of them by default).
   * @claim "Which checkpoints `run` happens at" scripts/check/first-run-session.test.mts verify:testExists(scripts/check/first-run-session.test.mts::first-run harness: a detour's whole session, and the report > runs a detour with no checkpoints of its own at every one)
   */
  at?(cp: string, app: AppConfig): boolean;
  /** What the person does at a checkpoint; the session judges what it leaves. */
  run?(s: FirstRunSession, cp: string, snap: Snapshot): Promise<void>;
};

const DECLINE = /^(No|Cancel|Not now|Skip|Don.t Allow|Later|Close)\b/;
/** The processes that show the system's permission questions (notifications, files, the camera). */
const ASKERS = ["UserNotificationCenter", "NotificationCenter", "CoreServicesUIAgent", "universalAccessAuthWarn", "tccd"];

/** Closes the window with its close button, and says whether it went from the screen. */
async function closeWindow(s: FirstRunSession): Promise<boolean> {
  s.interruptedAt ??= s.report.at();
  const pid = await s.app.pid();
  if (!pid) return true;
  // Pressed again once if the window is still up 4 s later: a press that lands as the window becomes key can be lost.
  for (let tries = 0; tries < 2; tries++) {
    s.app.activate();
    await s.eyes.closeWindow(pid);
    for (let i = 0; i < 8; i++) {
      await s.sys.sleep(500);
      if (!(await s.eyes.shown(pid))) return true;
    }
  }
  return false;
}

export const DETOURS: Detour[] = [
  { id: "dismiss-escape", title: "every dialog and sheet dismissed with Escape", dismiss: "escape" },
  { id: "dismiss-close", title: "every dialog and sheet dismissed with its close button", dismiss: "close" },
  { id: "dismiss-outside", title: "every dialog and sheet dismissed with a click outside it", dismiss: "outside" },
  {
    id: "controls",
    title: "every reachable control pressed before the sign-in finishes",
    at: (cp, app) => app.beforeSignIn(cp),
    async run(s, cp) {
      for (const c of s.app.controls) {
        s.app.activate();
        await c.act();
        await s.judgeAfter(`controls-${c.name}-at-${cp}`, `${c.name}, pressed at "${cp}"`);
        await s.eyes.key("escape");
        await s.sys.sleep(400);
      }
    },
  },
  {
    id: "quit",
    title: "quit at each step and opened again",
    async run(s, cp) {
      s.interruptedAt ??= s.report.at();
      const quit = await s.app.quit();
      s.report.step(`quit-at-${cp}`, quit, quit ? `quit at "${cp}"` : `at "${cp}", it was still running after Quit`);
      if (!(await s.app.open())) return;
      await s.judgeAfter(`reopened-after-quit-at-${cp}`, `opened again after quitting at "${cp}"`);
    },
  },
  {
    id: "reopen",
    title: "the window closed at each step and opened again from the Dock and from the menu bar",
    async run(s, cp) {
      if (!(await closeWindow(s))) return s.report.step(`reopen-at-${cp}`, false, `at "${cp}", the window's close button left the window on screen`);
      s.sys.start("open", [s.app.bundle]);
      await s.judgeAfter(`reopen-dock-at-${cp}`, `the window closed at "${cp}", then opened from the Dock`);
      if (s.app.menuBarItem === undefined) return;
      if (!(await closeWindow(s))) return s.report.step(`reopen-menu-bar-at-${cp}`, false, `at "${cp}", the window's close button left the window on screen`);
      const menu = await s.eyes.extraMenu(s.processPid(), s.app.menuBarItem);
      const open = menu.items.find((i) => i.enabled && (s.app.reopen ?? /^Open/).test(i.title));
      if (!open) {
        await s.eyes.key("escape");
        s.report.step(`reopen-menu-bar-at-${cp}`, false, `the window closed at "${cp}", and the menu bar item offers no way to open it (its items: ${menu.items.map((i) => i.title).join(", ") || "none"})`);
        s.sys.start("open", [s.app.bundle]);
        return;
      }
      await s.eyes.extraPress(open.title);
      await s.judgeAfter(`reopen-menu-bar-at-${cp}`, `the window closed at "${cp}", then "${open.title}" from the menu bar`);
    },
  },
  {
    id: "decline",
    title: "No or Cancel to every question",
    staySignedIn: false,
    async run(s, cp, snap) {
      if (!dialogs(snap).length) return;
      // forwardActions reads inside the topmost dialog when one is up: here, its No.
      const no = forwardActions(snap, { ...s.app.vocabulary, forward: s.app.decline ?? DECLINE })[0];
      if (!no) return;
      await s.eyes.press(await s.app.pid(), no);
      await s.judgeAfter(`decline-at-${cp}`, `"${no}" at "${cp}"`);
    },
  },
  {
    id: "cancel-sign-in",
    title: "the sign-in page cancelled",
    at: (cp, app) => app.signInPage(cp),
    async run(s, cp, snap) {
      s.app.activate();
      await s.eyes.key("escape");
      await s.judgeAfter(`cancel-escape-at-${cp}`, `Escape on the sign-in page "${cp}"`);
      const offered = new Set(snap.windows.flatMap((w) => w.nodes).flatMap((n) => (n.words ?? "").split(" | ")));
      for (const label of s.app.cancelSignIn ?? ["Back", "Cancel"]) {
        if (!offered.has(label)) continue;
        await s.eyes.press(await s.app.pid(), label);
        await s.judgeAfter(`cancel-${label.toLowerCase()}-at-${cp}`, `"${label}" on the sign-in page "${cp}"`);
        break;
      }
    },
  },
  {
    id: "deny-permissions",
    title: "every permission the app asks for denied",
    async run(s, cp, snap) {
      const asked = await s.app.askPermission?.(snap);
      if (!asked) return;
      let denied = "";
      for (let i = 0; i < 20 && !denied; i++) {
        await s.sys.sleep(500);
        for (const owner of ASKERS) {
          const pid = Number(s.sys.run("pgrep", ["-x", owner]).stdout.trim().split("\n")[0] || 0);
          for (const no of ["Don’t Allow", "Don't Allow", "Deny", "Not Now"]) if (pid && !denied && (await s.eyes.press(pid, no)).ok) denied = `${owner}'s "${no}"`;
        }
      }
      s.report.step(`deny-${asked}-at-${cp}`, true, denied ? `${asked}: the system asked, and ${denied} answered it` : `${asked}: the system asked nothing within 10 s (already decided on this machine), so there was nothing to deny`);
      await s.judgeAfter(`after-deny-${asked}-at-${cp}`, `${asked} denied at "${cp}"`);
    },
  },
  {
    id: "offline",
    title: "started offline, then the network came back",
    async before(s) {
      const block: Block = s.app.network ? unreachable(s.app.network, "offline: everything the app reaches unreachable", "refuse", s.sys) : offline(s.app.signInNetwork.probe, s.sys);
      s.report.step("offline", block.ok, block.evidence);
      return block.lift;
    },
    async start(s) {
      const t0 = s.report.at();
      while (s.report.at() - t0 < s.limits.offlineMs) {
        await s.observe(0);
        await s.sys.sleep(1000);
      }
      await s.stranded("offline", { signIn: false });
      s.report.note("network back");
    },
  },
];

/** The detours an app runs on a release candidate, with the main path, and those it runs nightly. */
export const RELEASE_DETOURS = ["dismiss-escape", "dismiss-close", "dismiss-outside"];
export const NIGHTLY_DETOURS = ["controls", "quit", "reopen", "decline", "cancel-sign-in", "deny-permissions", "offline"];
