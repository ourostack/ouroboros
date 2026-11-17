export { blank, BUDGETS, goTo, caption, check, dprAt, EXIT, group, HINTS, imagesReport, LABELS, main, merge, parseArgs, placeOf, RULES, runScript, SIZES, summary, transportIssues };
export type { Budgets, CheckOptions, CheckResult, Finding, Gate, ImageEntry, MergeOptions, Report };

import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, BrowserType, Page, Request } from "playwright";
import { findDesignIssues, listCornerMedia, mediaDrawn, readCorners, shownCorners, type CornerReading } from "./design-check.ts";
import { findImageFades } from "./fade-check.ts";
import { ALIASES, behindModal, boxOf, decodeImages, isReady, listAllowances, listenForReady, outline, runAxe, type Allowance, type Box } from "./in-page.ts";
import { findLoadingIssues, interactionSince, listenForMeasures, markPressables, NEVER_PRESS, pressPoint } from "./measure.ts";
import { findRepaints, listenForMotion, markWalkables, readMotion, resetMotion, type MotionReading } from "./motion-check.ts";
import { findOverlaps } from "./overlap-check.ts";
import { globToRegExp, listPages, serve } from "./serve.ts";
import { findSizeIssues, type ImageMeasure, type Measure, type PageIssue } from "./size-check.ts";
import { findTextIssues } from "./text-check.ts";
import { findLayoutIssues } from "./layout-check.ts";
import { findThemeIssues } from "./theme-check.ts";
import { findOffThemeIssues } from "./token-check.ts";
import { findInteractionIssues } from "./interaction-check.ts";
import { quietPipes, runCli, defineCli, defineCommand, parse, toArgv, type Cli, type CommandDef, type FlagSpec, type Input, BASE_EXIT_CODES, defineExitCodes, FINDINGS_EXIT_CODE, DEFAULT_OUTCOME_EXITS, outcome, type Outcome, AxError, commandLine, didYouMean, isAxError } from "./run.kit.mts";
import { findWrapIssues, readHeroArt, type HeroArt } from "./wrap-check.ts";

// Ouro check: every page at every screen size from a 320px phone to a 3840px screen, plus the short landscape screens of
// a dual-screen phone unfolded sideways, light and dark, at density 2 up to 3072px wide and 1 above. Pass and fail come from measurement, never from
// looking at pictures; the pictures are for the person who fixes what it finds.
//
//   node scripts/ouro/check/check.ts <url | built folder>… [--pages <glob>] [--out <folder>] [--sizes WxH,…]
//        [--themes light,dark] [--before <old report.json>] [--config ouro-check.json] [--no-axe]
//        [--no-measured] [--ready-event <name>] [--shard k/n] [--images-report <file.json>]
//   node scripts/ouro/check/check.ts merge <out folder>… [--out <folder>] [--config ouro-check.json] [--images-report <file.json>]
//
// Exits as every Ouro tool does (EXIT): 0 ok, 1 error (the check could not run), 2 usage, 3 findings. Playwright comes
// from the app's playwright (or PLAYWRIGHT_MODULE), Chromium from Playwright or BROWSER_EXECUTABLE, axe-core from the app or AXE_CORE.
// The browser always runs headless.

interface Finding {
  site: string;
  page: string;
  width: number;
  height: number;
  theme: string;
  rule: string;
  element: string;
  detail: string;
  gated: boolean;
  // A measured rule's number, its budget and their unit ("ms", or "" for a score): the record a later run compares.
  value?: number;
  budget?: number;
  unit?: string;
  // inp's presses of the control, each in ms, whose 75th percentile is its value.
  samples?: number[];
  // The device pixel ratio the page was drawn at (dprAt); missing in a report written before it was recorded.
  dpr?: number;
  // A blurry picture's numbers, and the file it drew when the check served it from a built folder.
  // url is the page's address: a URL target's own, or a built folder's page path, since its server's port changes each run.
  image?: ImageMeasure & { url?: string; file?: string };
  box?: Box;
  closeUp?: string;
  pair?: string;
}

// One picture in the images report: the largest file it needs, across every size and theme it was too small at.
interface ImageEntry {
  url: string;
  site: string;
  page: string;
  selector: string;
  element: string;
  currentSrc: string;
  naturalWidth: number;
  naturalHeight: number;
  renderedWidth: number;
  dpr: number;
  requiredWidth: number;
  file: string | null;
  sizes: string[];
}

// A finding from the --before report that this run did not find at its size: fixed, unless another size still has it.
interface Candidate extends Finding {
  before: string;
  after: string;
}

interface Shot {
  site: string;
  page: string;
  file: string;
  width: number;
  height: number;
  theme: string;
  count: number;
}

interface PageRef {
  site: string;
  page: string;
  name: string;
}

interface Report {
  targets: string[];
  sizes: [number, number][];
  themes: string[];
  shard?: string;
  pages: PageRef[];
  findings: Finding[];
  fixed: Finding[];
  candidates: Candidate[];
  // The elements a page opts out of a rule, with their reasons, once a page.
  allowances: (Allowance & { site: string; page: string })[];
  shots: Shot[];
}

interface CheckResult extends Report {
  gated: Finding[];
}

interface Budgets {
  inp: number;
  "layout-shift": number;
  "first-content": number;
  jank: number;
}

interface Gate {
  waive?: Record<string, Record<string, string>>;
  budgets?: Partial<Budgets>;
  // The controls inp may press, as CSS selectors, besides those marked data-ouro-check-press; and how often it presses
  // each.
  press?: string[];
  pressRepeat?: number;
  // Where long lines are checked, and against what: a page glob (two stars for all pages) holds the page's prose, a
  // CSS selector ("main .chat-message") holds what it matches. Without one the rule is off.
  measure?: Record<string, string>;
  // false: walk nothing, so jank measures no page.
  walk?: boolean;
  // The states a page reaches by presses, each checked as a page of its own: the page as the check names it ("/" or
  // "/?mock=1#/inbox"), then each state's name and the controls to press in turn to reach it, as Playwright selectors
  // ("text=Launch planning", "[role=tab] >> nth=1"). An app whose views have no address is checked in them this way.
  states?: Record<string, Record<string, string[]>>;
}

interface CheckOptions {
  targets: string[];
  out: string;
  pages?: string;
  sizes?: [number, number][];
  themes?: string[];
  shard?: [number, number];
  before?: Finding[];
  beforeDir?: string;
  config?: Gate;
  axe?: string | false;
  measured?: boolean;
  readyEvents?: string[];
  chromium: BrowserType;
  executablePath?: string;
  readyTimeout?: number;
  log?: (line: string) => void;
  /** How the https rule asks a site: fetch, unless a test gives another. */
  fetch?: typeof fetch;
}

interface MergeOptions {
  dirs: string[];
  out: string;
  config?: Gate;
  chromium: BrowserType;
  executablePath?: string;
}

interface Target extends PageRef {
  url: string;
  // The built folder the check serves the page from, so a picture's address can name its file.
  root?: string;
  // The presses that reach the target's state from its page, in turn.
  steps?: string[];
}

const SIZES: [number, number][] = [
  [320, 640], [360, 780], [390, 844], [480, 900], [600, 960], [720, 1000], [768, 1024], [900, 1000], [1024, 768], [1180, 820],
  [1280, 800], [1440, 900], [1680, 1050], [1920, 1080], [2560, 1440], [3200, 1800], [3840, 2160],
  // A dual-screen phone unfolded sideways, and other short landscape screens.
  [640, 360], [720, 420], [900, 500], [1000, 600],
];
// axe reads the same markup at every width, so it runs at a phone and a laptop size, or at the narrowest and widest of
// other sizes.
const AXE_SIZES = ["390x844", "1440x900"];
const LABELS: Record<string, string> = {
  overlap: "overlap",
  "sideways-scroll": "sideways scroll",
  "clipped-text": "clipped text",
  "long-lines": "long lines",
  "blurry-image": "blurry picture",
  "stretched-image": "stretched picture",
  "image-fade": "picture fades",
  axe: "accessibility (axe)",
  "broken-image": "broken picture",
  "http-error": "page did not load",
  "not-ready": "page not ready",
  "layout-shift": "layout shift while loading",
  "first-content": "slow first content",
  "first-paint-swap": "swap after first paint",
  inp: "slow press",
  "giant-picture": "giant picture",
  "cramped-heading": "cramped heading",
  "nested-frame": "frame in a frame",
  "baked-corner": "corner shows through",
  "type-scale": "type scale",
  "shadow-scale": "shadow scale",
  "grey-on-colour": "grey on colour",
  "heading-hierarchy": "heading hierarchy",
  jank: "jank",
  repaint: "repaints at rest",
  "leaked-value": "leaked value",
  "odd-timestamp": "odd timestamp",
  "console-error": "console error",
  "failed-request": "failed request",
  "off-screen": "off the screen",
  "duplicate-control": "control twice",
  "stray-scrollbar": "stray scrollbar",
  "focus-ring": "no focus ring",
  "dark-miss": "missed dark mode",
  "off-theme": "off the theme",
  "off-scale": "spacing off the scale",
  "hero-dark-art": "hero without night art",
  "disabled-no-reason": "disabled, no reason",
  "lone-word": "lone last word",
  "tall-heading": "tall heading",
  "one-word-line": "one-word line",
  "hard-break": "hard break in a heading",
  "narrow-heading": "narrow heading",
  "dark-art": "no dark art",
  https: "no HTTPS",
};
const RULES = Object.keys(LABELS);
// The exit codes every Ouro tool shares (the Ouro AX kit's table: 0 ok, 1 error, 2 usage), and this tool's own 3. A
// copy rather than an import: the kit installs where the app keeps its lib, and this file runs from scripts/ouro/check.
const EXIT = Object.freeze({ ok: 0, error: 1, usage: 2, findings: 3 });
// What usually causes a finding, for the person who fixes it.
const HINTS: Record<string, string> = {
  "blurry-image": "often a wrong `sizes` on a cropped, height-driven image",
  "stretched-image": "give it a width and a height in its own ratio (one of them auto), or let object-fit: cover crop it",
  "image-fade": "end the picture on a hard edge, or put it on a solid band",
  "giant-picture": "show the work itself (the component, a screenshot) or a small picture beside the words, not a banner",
  "cramped-heading": "give the heading room: more space above it than between it and what follows",
  "nested-frame": "draw one frame: drop the inner border, or make the inner radius the outer one less the inset",
  "baked-corner": "crop the recording to its content, or match the frame's radius to the window's and drop the frame's border",
  "type-scale": "pick the sizes and weights from one scale",
  "shadow-scale": "pick shadows from a few elevations",
  "grey-on-colour": "use a shade of the background's own hue, or white at reduced opacity",
  "heading-hierarchy": "size headings by rank: a heading under another is smaller",
  jank: "batch layout reads before writes, animate transform and opacity, and keep hover from moving content",
  repaint: "animate transform or opacity, outside SVG, or let the animation end",
  "leaked-value": "show a person's words for the value, or nothing, never what the program holds for itself",
  "odd-timestamp": "check the time was set before formatting it, and format it for a person: a date, a time or an age",
  "console-error": "fix what threw or warned; a warning a library prints is fixed by using it as it asks",
  "failed-request": "point the request at an address that answers, or don't make it",
  "off-screen": "keep it inside the screen: let it wrap or shrink, or let its row scroll",
  "duplicate-control": "show one; if both are needed, name each for what it does",
  "stray-scrollbar": "find what spills over by a few pixels (a margin, a border, a rounding) and fit it, or don't let the region scroll",
  "first-paint-swap": "draw the final controls in the first frame, a list that fits with More already in it, rather than replacing one a frame later",
  "focus-ring": "give it a :focus-visible outline in a colour that stands out from what is behind it",
  "dark-miss": "fill it from a theme token that has a dark value, not a fixed light colour",
  "off-theme": "take the value from the token the finding names (its var() or its Tailwind class), so a theme change reaches it",
  "off-scale": "take the spacing from the step the finding names (its Tailwind class, or a layout component's gap)",
  "hero-dark-art": "pass picture={{ light, dark }}, the same scene by day and at night",
  "disabled-no-reason": "say why beside it and tie the words to it with aria-describedby, or give it a title",
  "lone-word": "wrap it with text-wrap: pretty (balance for a heading or centred text), or keep a short phrase together",
  "tall-heading": "say it in fewer words, or draw it a step smaller on this screen",
  "one-word-line": "balance it (text-wrap: balance), and give it the column's full width",
  "hard-break": "take out the <br> or the block-level line spans, and let text-wrap: balance break it",
  "narrow-heading": "take off the max-width, and let the heading span its column and balance",
  "dark-art": "give the picture a night twin for the dark theme, as Hero's picture={{ light, dark }} does",
  https: "answer http:// with a 301 to https://, and send Strict-Transport-Security with max-age of a year or more",
};
// The measured rules' budgets, which ouro-check.json's "budgets" can change: the thresholds browsers' own field data
// calls good, a 0.1 layout shift, 2500 ms to the largest content and 200 ms from a press to its paint.
// jank's budget is the longest frame of a step, the median of its runs, from Ouro Feel; a step also fails when every run
// forces more than MAX_FORCED layouts or moves the page by more than MAX_STEP_SHIFT.
const BUDGETS: Budgets = Object.freeze({ inp: 200, "layout-shift": 0.1, "first-content": 2500, jank: 250 });
const MAX_FORCED = 50;
const MAX_STEP_SHIFT = 0.01;
// The walk: at most WALK_EACH states of each kind a page, each stepped WALK_RUNS times, at inp's size and theme.
const WALK_EACH = 3;
const WALK_RUNS = 3;
// How long a run waits for its target to be hittable again (a covered control, a dialog still closing) before its step is
// left unjudged.
const WALK_WAIT_MS = 2000;
// HSTS asks a year at least, as browsers' preload list does.
const HSTS_MIN = 31536000;
// How long a page's finite animations may run before the rules judge it anyway.
const SETTLE_MS = 2000;
// inp presses at most this many controls a page, each PRESS_REPEAT times unless ouro-check.json says otherwise, at one
// size and theme: a laptop's, or the widest given.
const MAX_PRESSES = 24;
const PRESS_REPEAT = 5;
const INP_SIZE = "1440x900";
// The device pixel ratio a screen `width` CSS pixels wide is drawn at: 2 up to 3072, the widest real 2x screen (a 6K
// display), and 1 above it, so a 3840 screen asks for the pictures a 4K monitor shows, not 8K-class files.
const dprAt = (width: number) => (width <= 3072 ? 2 : 1);
const MAX_CLOSE_UPS = 40;
const TABS = 4;

// Whether a page has a control listed for pressing, as an expression run in the page; and the error for a selector the
// browser refuses.
const anyListed = (press: string[]) => `document.querySelector(${JSON.stringify([...press, "[data-ouro-check-press]"].join(", "))}) !== null`;
const refused = (problem: Error): never => {
  throw new Error(`ouro-check.json's "press" has a selector the browser refuses: ${problem.message}`);
};
// The 75th percentile of some numbers, 0 for none.
const p75 = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.75) - 1] ?? 0;
// A first content over budget on both loads is reported once, at the lower of the two, from the first load's element; a
// second load within budget leaves no finding.
const lowerOfTwoLoads = (first: PageIssue, again: PageIssue | undefined): PageIssue | undefined => {
  if (!again) return undefined;
  const best = Math.min(first.value!, again.value!);
  return { ...first, value: best, samples: [first.value!, again.value!], detail: `${best} ms to its largest content at best of two loads (${first.value} ms, then ${again.value} ms), over the budget of ${first.budget} ms` };
};
const keyOf = (f: Finding) => `${f.site}\u0000${f.page}\u0000${f.rule}\u0000${f.element}`;
const spotOf = (f: Finding) => `${keyOf(f)}\u0000${f.width}x${f.height}\u0000${f.theme}`;
const pageOf = (f: { site: string; page: string }) => `${f.site} ${f.page}`;
const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
// A page's name for its files. A long one (a URL with a long query, say) keeps its start and a hash of the whole, so it
// fits a file name and two long names stay apart.
const fileName = (text: string) => {
  const name = text.replace(/\.html$/, "").replace(/\W+/g, "-").replace(/^-|-$/g, "") || "home";
  return name.length <= 80 ? name : `${name.slice(0, 60).replace(/-$/, "")}-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
};
const caption = (f: Finding) =>
  `${f.page} at ${f.width}×${f.height}@${f.dpr ?? dprAt(f.width)}x ${f.theme}: ${LABELS[f.rule] ?? f.rule}, ${f.element} (${f.detail})${HINTS[f.rule] ? `: ${HINTS[f.rule]}` : ""}`;
const raw = (file: string) => file.replace(/\.png$/, "-raw.png");
// Photographs `box` (page coordinates) as far as it shows on the screen once the page is scrolled to it, and returns
// the box it took. Never a full-page shot: its size is the root scroller's, which a clipped overflow, a scroll lock or
// an app shell's own scroller makes smaller than the page, and a box outside it fails. An element above or left of the
// page, or a fix that made the page smaller, gives the nearest part of the screen instead.
async function shoot(page: Page, path: string, box: Box): Promise<Box> {
  // The element in the middle of the screen, clear of a bar fixed to its top or side, and at once: a page that scrolls
  // smoothly would still be on its way.
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const at = (await page.evaluate(`scrollTo({ left: ${middle.x} - innerWidth / 2, top: ${middle.y} - innerHeight / 2, behavior: "instant" }), { sx: scrollX, sy: scrollY, vw: innerWidth, vh: innerHeight }`)) as { sx: number; sy: number; vw: number; vh: number };
  const x = Math.max(0, Math.min(box.x - at.sx, at.vw - 1));
  const y = Math.max(0, Math.min(box.y - at.sy, at.vh - 1));
  const clip = { x, y, width: Math.max(1, Math.min(box.x + box.width - at.sx, at.vw) - x), height: Math.max(1, Math.min(box.y + box.height - at.sy, at.vh) - y) };
  await page.screenshot({ path, clip, scale: "css" });
  return { x: clip.x + at.sx, y: clip.y + at.sy, width: clip.width, height: clip.height };
}

// A measure key is a page glob when it starts with a slash, or is only stars (two of them for all pages); anything else
// is a CSS selector, which may hold a slash of its own, as an attribute selector on an address can.
const isPageGlob = (key: string) => key.startsWith("/") || /^\*+$/.test(key);
const MEASURE = /^\d+(?:\.\d+)?\s*(?:px|ch|chars)$/;
// The measures that hold on `page`, in the order the config lists them.
const measuresFor = (config: Gate, page: string): Measure[] =>
  Object.entries(config.measure ?? {}).flatMap(([key, measure]): Measure[] =>
    !isPageGlob(key) ? [{ selector: key, measure }] : globToRegExp(key.startsWith("/") ? key : `/${key}`).test(page) ? [{ selector: null, measure }] : [],
  );

// Whether a finding fails the check: every one does unless the config waives its rule ("*" for every rule) on a page
// glob it matches. blurry-image is never waived: a picture too small for where it is drawn always fails.
const UNWAIVABLE = ["blurry-image"];
const isGated = (config: Gate, page: string, rule: string) =>
  UNWAIVABLE.includes(rule) ||
  !Object.entries(config.waive ?? {}).some(([glob, rules]) => Boolean(rules[rule] ?? rules["*"]) && globToRegExp(glob.startsWith("/") ? glob : `/${glob}`).test(page));

// The https rule, for a site on the web: http:// answers with a permanent redirect (301 or 308) to https://, and
// https:// answers with Strict-Transport-Security of a year or more. A bare name's www. twin (or the bare name, for a
// www. site) must move to https too, and answer there, when it answers at all. A local address has no certificate to check, and a site that does not
// listen on http:// serves nothing over it.
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|.+\.localhost)(:\d+)?$/;
async function transportIssues(host: string, ask: typeof fetch): Promise<{ element: string; detail: string }[]> {
  if (LOCAL.test(host)) return [];
  const issues: { element: string; detail: string }[] = [];
  const get = (url: string) =>
    ask(url, { redirect: "manual", signal: AbortSignal.timeout(10000) }).catch((problem: Error & { cause?: unknown }) => new Error(String(problem.cause ?? problem.message)));
  const plain = async (name: string) => {
    const response = await get(`http://${name}/`);
    if (response instanceof Error) return false;
    const location = response.headers.get("location") ?? "";
    if ([301, 308].includes(response.status) && location.startsWith("https://")) return true;
    const moves = response.status >= 300 && response.status < 400;
    issues.push({ element: `http://${name}/`, detail: moves ? `moves to ${location || "nowhere"} with ${response.status}, not to https:// with a 301` : `answers ${response.status} over plain HTTP instead of moving to https://` });
    return true;
  };
  const secure = async (name: string, twin: boolean) => {
    const response = await get(`https://${name}/`);
    if (response instanceof Error) return void issues.push({ element: `https://${name}/`, detail: `does not answer over HTTPS: ${response.message}` });
    if (twin) return;
    const age = /max-age=(\d+)/i.exec(response.headers.get("strict-transport-security") ?? "");
    if (!age || Number(age[1]) < HSTS_MIN) issues.push({ element: `https://${name}/`, detail: age ? `Strict-Transport-Security max-age=${age[1]}, under a year` : "sends no Strict-Transport-Security" });
  };
  await plain(host);
  await secure(host, false);
  // A bare name (two labels) and its www. name are one site; a subdomain such as ui. has no twin.
  const twin = host.startsWith("www.") ? host.slice(4) : host.split(".").length === 2 ? `www.${host}` : null;
  if (twin && (await plain(twin))) await secure(twin, true);
  return issues;
}

async function targetsOf(targets: string[], glob: string | undefined): Promise<{ list: Target[]; close: () => Promise<void> }> {
  const list: Target[] = [];
  const servers: { close: () => Promise<void> }[] = [];
  for (const target of targets) {
    if (/^https?:\/\//.test(target)) {
      const url = new URL(target);
      list.push({ site: url.host, page: `${url.pathname}${url.search}${url.hash}`, url: url.href, name: "" });
      continue;
    }
    const server = await serve(target);
    servers.push(server);
    for (const page of await listPages(target, glob)) list.push({ site: basename(resolve(target)), page, url: `${server.origin}${page}`, name: "", root: resolve(target) });
  }
  const sites = new Set(list.map((t) => t.site));
  for (const t of list) t.name = fileName(sites.size > 1 ? `${t.site}${t.page}` : t.page);
  return { list, close: async () => void (await Promise.all(servers.map((s) => s.close()))) };
}

// Opens about:blank. A navigation the page started itself (a press that left it, its address still the old one until the
// answer comes) can win over this one, which Playwright reports as interrupted: the page's navigation is let finish, and
// the blank page opened again, a few times at most. A navigation to about:blank that wins leaves the page where this
// wants it, so once it has loaded there that is done (main run 43711248976).
async function blank(page: Pick<Page, "goto" | "waitForLoadState" | "url">): Promise<void> {
  // Lets the navigation that won finish, and says whether it left the page on about:blank; any other failure is thrown.
  const onBlank = async (problem: unknown): Promise<boolean> => {
    if (!/is interrupted by another navigation/.test((problem as Error).message)) throw problem;
    await page.waitForLoadState("load");
    return page.url() === "about:blank";
  };
  for (let attempt = 1; attempt < 3; attempt++) {
    try {
      await page.goto("about:blank");
      return;
    } catch (problem) {
      if (await onBlank(problem)) return;
    }
  }
  try {
    await page.goto("about:blank");
  } catch (problem) {
    if (!(await onBlank(problem))) throw problem;
  }
}

const RACE_WAIT = 5000;

// Goes to a page from the blank one. An about:blank navigation still landing after blank() returned (#1521), or one to
// the same page that a press set off before (#1595), can win over this one, which Playwright reports as interrupted:
// that navigation is let finish, and the page asked for again, a few times at most, so its own answer is the one read.
// It finishes with its own load event: the page it replaces had fired its load already, so waitForLoadState would return
// at once and the next try could meet the same navigation again (#1641). A load that came before the wait is waited for
// no longer than RACE_WAIT.
async function goTo(page: Pick<Page, "goto" | "waitForEvent">, url: string): Promise<Awaited<ReturnType<Page["goto"]>>> {
  const raced = (message: string) => [`another navigation to "about:blank"`, `another navigation to "${url}"`].some((to) => message.includes(`is interrupted by ${to}`));
  for (let attempt = 1; attempt < 3; attempt++) {
    try {
      return await page.goto(url, { waitUntil: "load" });
    } catch (problem) {
      if (!raced((problem as Error).message)) throw problem;
      await page.waitForEvent("load", { timeout: RACE_WAIT }).catch(() => undefined);
    }
  }
  return page.goto(url, { waitUntil: "load" });
}

// Opens a page and waits for it to draw. Returns why it did not load (a status other than 2xx, or no answer at all),
// and whether it said it was ready before readyTimeout ran out.
async function open(page: Page, url: string, readyTimeout: number): Promise<{ failed: string | null; ready: boolean }> {
  // Asked from Node first: a browser that gets no answer starts loading its own error page, which would pull the page
  // from under the shots.
  const answered = await fetch(url, { method: "HEAD" }).then(
    () => null,
    (problem: Error & { cause: unknown }) => `no answer: ${String(problem.cause)}`,
  );
  if (answered) {
    await page.setContent(`<p style="font:16px system-ui;padding:16px">${escape(answered)}</p>`);
    return { failed: answered, ready: true };
  }
  // From a blank page, so each page loads afresh: goto answers null for a same-document move, as from an app's page to
  // one of its routes (the same address but its hash), and the app would keep what it held.
  await blank(page);
  const response = (await goTo(page, url))!;
  if (!response.ok()) return { failed: `answered ${response.status()}`, ready: true };
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
  const ready = await page.waitForFunction(isReady, null, { timeout: readyTimeout }).then(
    () => true,
    () => false,
  );
  await page.evaluate("document.fonts.ready.then(() => undefined)");
  await settle(page);
  return { failed: null, ready };
}

// console-error and failed-request: what went wrong in the page while it loaded and was checked, heard from the browser
// from before the page opens. console-error is an uncaught error, or console.error or console.warn, React's warnings
// among them. failed-request is a request to the page's own origin that answered 400 or more, or got no answer; the
// page's own document is http-error's and a picture is broken-image's, and Chromium's own "Failed to load resource" line
// is the request's, so one failure makes one finding. An aborted request (a navigation away, a media preload) is no
// failure. Named by its path, without the server's address, which changes each run, or its query, so each size finds the
// same thing and a page that polls finds it once.
function listenForRuntime(page: Page, url: string): () => PageIssue[] {
  const origin = new URL(url).origin;
  const local = (text: string) => text.split(origin).join("");
  // A request is named by its path, without its query, so a page that polls a missing address makes one finding.
  const path = (address: string) => new URL(address).pathname;
  const found = new Map<string, PageIssue>();
  const add = (rule: string, element: string, detail: string) => {
    if (!found.has(rule + element)) found.set(rule + element, { ref: "", rule, element, detail });
  };
  const skip = (request: Request) =>
    new URL(request.url()).origin !== origin || request.resourceType() === "image" || (request.isNavigationRequest() && request.frame() === page.mainFrame());
  page.on("pageerror", (problem) => add("console-error", `uncaught ${problem.name}: ${local(problem.message.split("\n")[0]!)}`.slice(0, 160), "thrown and not caught"));
  page.on("console", (message) => {
    const kind = message.type();
    if ((kind !== "error" && kind !== "warning") || message.text().startsWith("Failed to load resource")) return;
    const { url: at, lineNumber } = message.location();
    add("console-error", `console.${kind === "error" ? "error" : "warn"}: ${local(message.text().split("\n")[0]!)}`.slice(0, 160), `at ${local(at)} line ${lineNumber + 1}`);
  });
  page.on("response", (response) => {
    if (response.status() < 400 || skip(response.request())) return;
    add("failed-request", `${response.request().method()} ${path(response.url())}`, `answered ${response.status()}`);
  });
  page.on("requestfailed", (request) => {
    const why = request.failure()!.errorText;
    if (why.includes("ERR_ABORTED") || skip(request)) return;
    add("failed-request", `${request.method()} ${path(request.url())}`, `no answer (${why})`);
  });
  return () => [...found.values()];
}

// Lets the page's finite animations run to their end, for up to 2 s, so no rule judges it part way through one: a toast
// fading in would read as low contrast, and a panel sliding in as out of place.
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    `Promise.race([Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))), new Promise((done) => setTimeout(done, ${SETTLE_MS}))]).then(() => undefined)`,
  );
}

async function check(options: CheckOptions): Promise<CheckResult> {
  const { out, chromium, executablePath, sizes = SIZES, themes = ["light", "dark"], shard = [1, 1], before = [], config = {}, axe = false, measured = true, readyEvents = [], readyTimeout = 15000, log = console.log, fetch: ask = fetch } = options;
  const budgets: Budgets = { ...BUDGETS, ...config.budgets };
  const repeats = config.pressRepeat ?? PRESS_REPEAT;
  const { list: opened, close } = await targetsOf(options.targets, options.pages);
  // Each page, then each state of it, named after the page and the state.
  const list = opened.flatMap((t) => [t, ...Object.entries(config.states?.[t.page] ?? {}).map(([state, steps]) => ({ ...t, page: `${t.page} (${state})`, name: fileName(`${t.name}-${state}`), steps }))]);
  // --shard k/n: the kth of every n (page, size) pairs, taken along the diagonal so each job gets a share of the pages
  // at every size and a share of the sizes of every page, whatever the counts.
  const [k, n] = shard;
  const unit = (size: number, page: number) => (size + page) % n === k - 1;
  const swept = list.filter((_, p) => sizes.some((_, s) => unit(s, p)));
  const report: Report = { targets: options.targets, sizes, themes, ...(n > 1 ? { shard: `${k}/${n}` } : {}), pages: swept.map(({ site, page, name }) => ({ site, page, name })), findings: [], fixed: [], candidates: [], shots: [], allowances: [] };
  if (!swept.length) {
    await close();
    // A shard with nothing to sweep still writes its report, so a merge of every shard's folder works.
    await mkdir(out, { recursive: true });
    await write(out, report);
    return { ...report, gated: [] };
  }
  // A browser that does not start leaves no server running behind it.
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }).catch(async (problem: unknown) => {
    await close();
    throw problem;
  });
  // A measure's selector the browser cannot read is a mistake in the config, found once before the sweep.
  const probe = await browser.newPage();
  const selectors = Object.keys(config.measure ?? {}).filter((key) => !isPageGlob(key));
  const unreadable = (await probe.evaluate(`${JSON.stringify(selectors)}.filter((s) => { try { document.querySelector(s); return false; } catch { return true; } })`)) as string[];
  await probe.close();
  if (unreadable.length) {
    await browser.close();
    await close();
    throw Object.assign(new Error(`the measure for "${unreadable[0]}" names no CSS selector a browser reads; write a valid selector, or a page glob that starts with "/".`), { usage: true });
  }
  const { findings, shots, candidates } = report;
  const pictured = new Set<string>();
  const allowed = new Set<string>();
  const closeUps = new Map(list.map((t) => [t, 0]));
  const sizeKeys = sizes.map(([w, h]) => `${w}x${h}`);
  const axeAt = new Set(sizeKeys.some((key) => AXE_SIZES.includes(key)) ? AXE_SIZES : [sizeKeys[0], sizeKeys.at(-1)]);
  const inpAt = `${sizeKeys.includes(INP_SIZE) ? INP_SIZE : sizeKeys.at(-1)} ${themes[0]}`;
  for (const dir of ["sheets/shots", "findings", "pairs/raw"]) await mkdir(join(out, dir), { recursive: true });
  // The earlier close-ups, read before this run writes its own, which take the same names when --out is the earlier
  // report's folder.
  const earlier = new Map<string, Buffer>();
  for (const f of before) {
    if (!f.closeUp || earlier.has(f.closeUp)) continue;
    const shot = await readFile(join(options.beforeDir ?? ".", raw(f.closeUp))).catch(() => undefined);
    if (shot) earlier.set(f.closeUp, shot);
  }

  // Pages are checked with reduced motion, so a screenshot holds still; the walk moves as most people see a page.
  const contextFor = async (width: number, height: number, theme: string, motion: "reduce" | "no-preference" = "reduce") => {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dprAt(width), colorScheme: theme as "light" | "dark", reducedMotion: motion });
    await context.addInitScript(listenForReady, ["ouro:ready", ...readyEvents]);
    if (measured) {
      await context.addInitScript(listenForMeasures);
      await context.addInitScript(listenForMotion);
    }
    return context;
  };
  // Opens a target's page and, for a state, presses its way there, letting the page settle after each press. A press that
  // finds nothing to press fails the state as a page that did not load.
  const reach = async (page: Page, target: Target): Promise<{ failed: string | null; ready: boolean }> => {
    const opened = await open(page, target.url, readyTimeout);
    if (opened.failed) return opened;
    for (const step of target.steps ?? []) {
      try {
        await page.locator(step).first().click({ timeout: 5000 });
      } catch (problem) {
        return { failed: `the state's press ${JSON.stringify(step)} found nothing to press (${(problem as Error).message.split("\n")[0]})`, ready: opened.ready };
      }
      await page.evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))");
      await page.waitForTimeout(500);
      await settle(page);
    }
    return opened;
  };
  // A finding, recorded, and photographed with its element outlined unless the page already has one of it or 40.
  const record = async (page: Page, target: Target, issue: PageIssue, width: number, height: number, theme: string) => {
    const { ref, rule, element, detail, value, budget, unit, samples, image } = issue;
    const measured = value === undefined ? {} : { value, budget: budget!, unit: unit!, ...(samples ? { samples } : {}) };
    const f: Finding = { site: target.site, page: target.page, width, height, theme, rule, element, detail, ...measured, gated: isGated(config, target.page, rule), dpr: dprAt(width), ...(image ? { image: { ...image, ...placeOf(target, image.src) } } : {}) };
    findings.push(f);
    const key = keyOf(f);
    if (pictured.has(key) || closeUps.get(target)! >= MAX_CLOSE_UPS) return;
    pictured.add(key);
    closeUps.set(target, closeUps.get(target)! + 1);
    const box = await page.evaluate(boxOf, { ref, width, height });
    await page.evaluate(outline, { ref, on: true });
    f.closeUp = `findings/${target.name}-${closeUps.get(target)}.png`;
    f.box = await shoot(page, join(out, raw(f.closeUp)), box);
    await page.evaluate(outline, { ref, on: false });
  };
  // inp: presses each listed control in turn, a few times, and Escape after each press, to close what it opened. A
  // press that starts a navigation counts as leaving the page, even before the address changes: the page opens again
  // and that control's presses end. The finding is the presses' 75th percentile, so one slow press on a busy machine
  // does not make one; its photograph is the page after the presses.
  const press = async (page: Page, target: Target, width: number, height: number, theme: string) => {
    let found = 0;
    let at = page.url();
    // Counts the navigations the page's main frame requests, which a press starts before the address changes.
    let navigations = 0;
    const onRequest = (request: Request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;
    };
    page.on("request", onRequest);
    try {
      const mark = () => page.evaluate(markPressables, { limit: MAX_PRESSES, press: config.press ?? [], never: NEVER_PRESS });
      let controls = await mark();
      const reopen = async () => {
        await reach(page, target);
        at = page.url();
        controls = await mark();
      };
      // By index: a page opened again is marked again, in the same order.
      for (let i = 0; i < controls.length; i++) {
        const { ref, element } = controls[i]!;
        const samples: number[] = [];
        for (let n = 0; n < repeats; n++) {
          let point;
          try {
            point = await page.evaluate(pressPoint, { ref, never: NEVER_PRESS });
          /* node:coverage disable */
          } catch (problem) {
            // A navigation that committed before the listener saw its request ends the page's context, so the press left.
            if (!/Execution context was destroyed|navigat/i.test((problem as Error).message)) throw problem;
            await reopen();
            break;
          }
          /* node:coverage enable */
          if (!point) break;
          const since = (await page.evaluate("performance.now()")) as number;
          const requested = navigations;
          await page.mouse.click(point.x, point.y);
          /* node:coverage ignore next */
          const ms = await page.evaluate(interactionSince, since).catch(() => 0);
          await page.keyboard.press("Escape");
          if (navigations !== requested || page.url() !== at) {
            await reopen();
            break;
          }
          samples.push(ms);
        }
        const value = p75(samples);
        if (value > budgets.inp) {
          found++;
          const detail = `${value} ms from the press to its paint at the 75th percentile of ${samples.length} presses, over the budget of ${budgets.inp} ms`;
          await record(page, target, { ref, rule: "inp", element, detail, value, budget: budgets.inp, unit: "ms", samples }, width, height, theme);
        }
      }
      return found;
    } finally {
      page.off("request", onRequest);
    }
  };
  // baked-corner: each picture and video as drawn, from its top, as far as the screen shows it, with the corners the
  // screen shows of it.
  const cornerShots = async (page: Page, height: number): Promise<CornerReading[]> => {
    const readings: CornerReading[] = [];
    for (const media of await page.evaluate(listCornerMedia, 12)) {
      // Centred on the screen, or its top a quarter down when it is taller, clear of a fixed bar at the top; measured
      // again once it has drawn, since the page may have moved.
      await page.evaluate(`scrollTo({ top: ${media.box.y - Math.max(height / 4, (height - media.box.height) / 2)}, behavior: "instant" })`);
      await page.evaluate(mediaDrawn, media.ref);
      const { corners, clip } = await page.evaluate(shownCorners, media.ref);
      // The rule needs two corners on the screen; a media scrolled out of view in a strip of its own shows none.
      if (corners.length < 2) continue;
      const shot = await page.screenshot({ clip, scale: "css" });
      readings.push({ ref: media.ref, element: media.element, radius: media.radius, behind: media.behind, own: media.own, corners, shot: `data:image/png;base64,${shot.toString("base64")}` });
    }
    return readings;
  };
  // jank: steps through each state the page offers (hover a card, open and close a popup, scroll or pan a region)
  // WALK_RUNS times, reading Ouro Feel's measures after each. A step fails when its median longest frame is over the
  // budget, or every run forces more than MAX_FORCED layouts or shifts the page more than MAX_STEP_SHIFT, so one slow
  // run on a busy machine does not make a finding. A step whose target a run cannot reach (even after WALK_WAIT_MS) is
  // not judged at all, rather than judged on fewer runs.
  const aim = async (page: Page, ref: string): Promise<{ x: number; y: number } | null> => {
    try {
      const handle = await page.waitForFunction(pressPoint, { ref, never: "[data-ouro-check-never-walk]" }, { timeout: WALK_WAIT_MS, polling: 100 });
      const point = (await handle.jsonValue()) as { x: number; y: number };
      await handle.dispose();
      return point;
    } catch {
      return null;
    }
  };
  const walk = async (page: Page, target: Target, width: number, height: number, theme: string) => {
    let found = 0;
    // At rest first, before anything is hovered or opened.
    for (const issue of await page.evaluate(findRepaints)) {
      found++;
      await record(page, target, issue, width, height, theme);
    }
    const settle = () => page.waitForTimeout(400);
    for (const step of await page.evaluate(markWalkables, { limit: WALK_EACH, never: NEVER_PRESS })) {
      const runs: MotionReading[] = [];
      for (let n = 0; n < WALK_RUNS; n++) {
        // Away from everything, and two frames for the page to settle back, so each run starts from rest and aims at the
        // target where it rests.
        await page.mouse.move(0, 0);
        await page.evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))");
        const point = step.page ? { x: width / 2, y: height / 2 } : await aim(page, step.ref);
        if (!point) break;
        await page.evaluate(resetMotion);
        // Straight to the target in one move, so the pointer's path hovers nothing else on the way.
        if (step.kind === "hover") await page.mouse.move(point.x, point.y);
        else if (step.kind === "open") {
          await page.mouse.click(point.x, point.y);
          await settle();
          await page.keyboard.press("Escape");
        } else if (step.kind === "pan") {
          await page.mouse.move(point.x, point.y);
          await page.mouse.down();
          await page.mouse.move(point.x - 160, point.y - 80, { steps: 12 });
          await page.mouse.up();
        } else {
          await page.mouse.move(point.x, point.y);
          for (let w = 0; w < 6; w++) await page.mouse.wheel(step.axis === "x" ? 120 : 0, step.axis === "x" ? 0 : 120);
        }
        await settle();
        runs.push(await page.evaluate(readMotion));
      }
      if (runs.length < WALK_RUNS) continue;
      const frame = [...runs.map((r) => r.longestFrameMs)].sort((a, b) => a - b)[Math.floor(runs.length / 2)]!;
      const forced = Math.min(...runs.map((r) => r.forcedLayouts));
      const shift = Math.min(...runs.map((r) => r.shift));
      const over = [
        frame > budgets.jank ? `its longest frame took ${frame} ms (median of ${runs.length}; budget ${budgets.jank} ms)` : "",
        forced > MAX_FORCED ? `it forced ${forced} layouts in its best run (keep to ${MAX_FORCED})` : "",
        // Opening a disclosure moves what follows it on purpose, so an open step's shift isn't judged.
        step.kind !== "open" && shift > MAX_STEP_SHIFT ? `it moved the page by a layout shift of ${shift} in its best run (keep to ${MAX_STEP_SHIFT})` : "",
      ].filter(Boolean);
      if (!over.length) continue;
      found++;
      const verb = { "hover": "hovering", open: "opening and closing", scroll: "scrolling", pan: "panning" }[step.kind];
      await record(page, target, { ref: step.ref, rule: "jank", element: `${verb} ${step.element}`, detail: over.join("; "), value: frame, budget: budgets.jank, unit: "ms", samples: runs.map((r) => r.longestFrameMs) }, width, height, theme);
    }
    return found;
  };
  // A first content over budget is measured again on a second load in a browser context of its own: one slow load on a
  // busy runner is not the page. A second load that cannot reach the page keeps the first finding as it was, since
  // nothing shows that the page was within budget.
  const measureAgain = async (target: Target, width: number, height: number, theme: string, first: PageIssue): Promise<PageIssue | undefined> => {
    const context = await contextFor(width, height, theme);
    try {
      const tab = await context.newPage();
      if ((await reach(tab, target)).failed) return first;
      const again = (await tab.evaluate(findLoadingIssues, budgets)).find((issue) => issue.rule === "first-content");
      return lowerOfTwoLoads(first, again);
    } finally {
      await context.close();
    }
  };
  // Each page's hero art in its light run, by page and size, for dark-art in its dark run.
  const lightArt = new Map<string, HeroArt | null>();
  const checkPage = async (page: Page, target: Target, width: number, height: number, theme: string) => {
    const runtime = listenForRuntime(page, target.url);
    const { failed, ready } = await reach(page, target);
    const issues: PageIssue[] = [];
    if (failed) issues.push({ ref: "", rule: "http-error", element: "the page", detail: failed });
    else {
      // Checked as it is, but never a pass: on a slower machine the same page could draw something else in time.
      if (!ready) issues.push({ ref: "", rule: "not-ready", element: "the page", detail: `no ready signal in ${readyTimeout / 1000} s (ouro:ready, data-app-ready or a drawn h1)` });
      // The loading measures first, before any rule scrolls: a script's scroll doesn't end largest-contentful-paint as a
      // person's does, so a picture far down that a later rule scrolls to would otherwise read as the first content.
      if (measured) {
        const loading = await page.evaluate(findLoadingIssues, budgets);
        const first = loading.find((issue) => issue.rule === "first-content");
        issues.push(...loading.filter((issue) => issue !== first));
        if (first) {
          const settled = await measureAgain(target, width, height, theme, first);
          if (settled) issues.push(settled);
        }
      }
      // axe first: it names an element by its rarest attribute, which would otherwise be the other rules' marks, a new
      // one at each size.
      if (axe && axeAt.has(`${width}x${height}`)) {
        await page.evaluate(axe);
        issues.push(...(await page.evaluate(runAxe)));
      }
      // The layout, text and design rules read what a person sees. While a modal is open, the page behind it is out of
      // reach and laid out for the modal (its scroll locked), so its findings are left to the page's own run.
      const shown: typeof issues = [];
      shown.push(...(await page.evaluate(findOverlaps, {})));
      await page.evaluate(decodeImages);
      shown.push(...(await page.evaluate(findSizeIssues, { measures: measuresFor(config, target.page) })));
      shown.push(...(await page.evaluate(findImageFades)));
      shown.push(...(await page.evaluate(findDesignIssues, {})));
      shown.push(...(await page.evaluate(findTextIssues)));
      shown.push(...(await page.evaluate(findLayoutIssues, {})));
      shown.push(...(await page.evaluate(findThemeIssues, {})));
      // off-theme and off-scale read the page's style rules, the same at every size and theme: at one, inp's.
      if (inpAt === `${width}x${height} ${theme}`) shown.push(...(await page.evaluate(findOffThemeIssues, {})));
      shown.push(...(await page.evaluate(findInteractionIssues)));
      shown.push(...(await page.evaluate(findWrapIssues, {})));
      const behind = new Set(await page.evaluate(behindModal, [...new Set(shown.map((issue) => issue.ref))]));
      issues.push(...shown.filter((issue) => !behind.has(issue.ref)));
      // dark-art: light runs before dark at each size, so the dark run compares with the light run's hero art.
      const art = await page.evaluate(readHeroArt, {});
      const artKey = `${target.site}\u0000${target.page}\u0000${width}x${height}`;
      if (theme === "light") lightArt.set(artKey, art);
      else if (theme === "dark" && art?.darkPage && lightArt.get(artKey)?.src === art.src)
        issues.push({ ref: art.ref, rule: "dark-art", element: art.element, detail: `the dark theme shows the light theme's picture, ${art.src.split("/").pop()}` });
      const corners = await page.evaluate(readCorners, await cornerShots(page, height));
      const cornersBehind = new Set(await page.evaluate(behindModal, [...new Set(corners.map((issue) => issue.ref))]));
      issues.push(...corners.filter((issue) => !cornersBehind.has(issue.ref)));
      issues.push(...runtime());
      for (const a of await page.evaluate(listAllowances, ALIASES)) {
        const key = JSON.stringify([target.site, target.page, a.rules, a.element, a.reason]);
        if (allowed.has(key)) continue;
        allowed.add(key);
        report.allowances.push({ site: target.site, page: target.page, ...a });
      }
    }
    for (const issue of issues) await record(page, target, issue, width, height, theme);
    const file = `${target.name}-${width}x${height}-${theme}.jpg`;
    await page.evaluate("window.scrollTo(0, 0)");
    await page.screenshot({ path: join(out, "sheets/shots", file), type: "jpeg", quality: 70, scale: "css" });
    // Pressed in a context of its own, so what a press saves (a theme, a dismissed banner) reaches no other page.
    // Only on a page with a control listed for pressing: pressing is opt-in.
    let pressed = 0;
    const listed = measured && !failed && inpAt === `${width}x${height} ${theme}` && ((await page.evaluate(anyListed(config.press ?? [])).catch(refused)) as boolean);
    if (listed) {
      const own = await contextFor(width, height, theme);
      const tab = await own.newPage();
      await reach(tab, target);
      pressed = await press(tab, target, width, height, theme);
      await own.close();
    }
    let walked = 0;
    if (measured && !failed && config.walk !== false && inpAt === `${width}x${height} ${theme}`) {
      const own = await contextFor(width, height, theme, "no-preference");
      const tab = await own.newPage();
      await reach(tab, target);
      walked = await walk(tab, target, width, height, theme);
      await own.close();
    }
    const count = issues.length + pressed + walked;
    log(`${count ? "✗" : "✓"} ${`${width}×${height}`.padEnd(9)} ${theme.padEnd(5)} ${pageOf(target)}${count ? `: ${count}` : ""}`);
    shots.push({ site: target.site, page: target.page, file, width, height, theme, count });
  };

  try {
    // https, once a site, in the first shard.
    if (k === 1) {
      for (const host of new Set(list.map((t) => new URL(t.url).host))) {
        for (const { element, detail } of await transportIssues(host, ask)) {
          findings.push({ site: host, page: "/", width: sizes[0]![0], height: sizes[0]![1], theme: themes[0]!, rule: "https", element, detail, gated: isGated(config, "/", "https"), dpr: dprAt(sizes[0]![0]) });
        }
      }
    }
    for (const [s, [width, height]] of sizes.entries()) {
      const active = list.filter((_, p) => unit(s, p));
      for (const theme of themes) {
        if (!active.length) continue;
        const queue = [...active];
        // A few pages at once, each in a browser context of its own, so what one saves (an app's last view, a dismissed
        // banner) reaches no other and no state starts from another's.
        await Promise.all(
          Array.from({ length: Math.min(TABS, active.length) }, async () => {
            for (let target = queue.shift(); target; target = queue.shift()) {
              const context = await contextFor(width, height, theme);
              await checkPage(await context.newPage(), target, width, height, theme);
              await context.close();
            }
          }),
        );
      }
    }

    // Findings in the earlier report that this run swept the same spot of and did not find there: the same spot, at
    // the same size, after. Whether each is fixed depends on every size, which a merge of shards decides.
    const found = new Set(findings.map(spotOf));
    for (const f of before) {
      const target = list.find((t) => t.site === f.site && t.page === f.page);
      const s = sizes.findIndex(([w, h]) => w === f.width && h === f.height);
      if (!f.closeUp || !f.box || !target || s < 0 || !themes.includes(f.theme) || !unit(s, list.indexOf(target)) || found.has(spotOf(f))) continue;
      const i = candidates.length + 1;
      const candidate: Candidate = { ...f, before: `pairs/raw/${i}-before.png`, after: `pairs/raw/${i}-after.png` };
      delete candidate.pair;
      const shot = earlier.get(f.closeUp);
      if (!shot) {
        log(`No close-up for "${caption(f)}" beside the earlier report; it gets no before and after.`);
        continue;
      }
      await writeFile(join(out, candidate.before), shot);
      const context = await contextFor(f.width, f.height, f.theme);
      const page = await context.newPage();
      await reach(page, target);
      await shoot(page, join(out, candidate.after), f.box);
      await context.close();
      candidates.push(candidate);
    }
    report.fixed = await compose(browser, out, report);
  } finally {
    await browser.close();
    await close();
  }
  await write(out, report);
  return { ...report, gated: findings.filter((f) => f.gated) };
}

// The composites: a captioned close-up per pictured finding, a captioned before and after per fixed finding, and a
// contact sheet per page. Returns the fixed findings.
async function compose(browser: Browser, out: string, report: Report): Promise<Finding[]> {
  const now = new Set(report.findings.map(keyOf));
  const fixed: Finding[] = [];
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const render = async (html: string, file: string) => {
    await writeFile(
      join(out, `${file}.html`),
      `<!doctype html><meta charset=utf-8><style>body{font:14px system-ui,sans-serif;margin:0;padding:16px;background:#f4f2ee;color:#1b1b1b;width:max-content;max-width:3000px}h1{font-size:16px;font-weight:600;margin:0 0 12px;max-width:1400px}.row{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end}figure{margin:0}img{display:block;border:1px solid #bbb;background:#fff;max-width:1400px}figcaption{margin-top:4px}b{color:#b3261e}</style>${html}`,
    );
    await page.goto(pathToFileURL(join(out, `${file}.html`)).href);
    await page.evaluate(decodeImages);
    const { width, height } = (await page.evaluate("({ width: document.body.scrollWidth, height: document.body.scrollHeight })")) as { width: number; height: number };
    await page.screenshot({ path: join(out, `${file}.png`), fullPage: true, clip: { x: 0, y: 0, width, height } });
    await rm(join(out, `${file}.html`));
  };
  const src = (file: string) => pathToFileURL(join(out, file)).href;
  const nameOf = (f: { site: string; page: string }) => report.pages.find((p) => p.site === f.site && p.page === f.page)!.name;
  try {
    for (const f of report.findings.filter((f) => f.closeUp)) await render(`<h1>${escape(caption(f))}</h1><img src="${src(raw(f.closeUp!))}">`, f.closeUp!.replace(/\.png$/, ""));
    for (const c of report.candidates.filter((c) => !now.has(keyOf(c)))) {
      const { before, after, ...f } = c;
      f.pair = `pairs/${nameOf(f)}-${fixed.length + 1}.png`;
      fixed.push(f);
      await render(
        `<h1>Fixed: ${escape(caption(f))}</h1><div class="row"><figure><img src="${src(before)}"><figcaption>Before</figcaption></figure><figure><img src="${src(after)}"><figcaption>After</figcaption></figure></div>`,
        f.pair.replace(/\.png$/, ""),
      );
    }
    for (const ref of report.pages) {
      const tiles = report.shots
        .filter((s) => s.site === ref.site && s.page === ref.page)
        .map((s) => `<figure><img src="${src(`sheets/shots/${s.file}`)}" style="height:260px"><figcaption>${s.width}×${s.height}@${dprAt(s.width)}x ${s.theme}${s.count ? ` · <b>${s.count} finding${s.count > 1 ? "s" : ""}</b>` : " · ✓"}</figcaption></figure>`)
        .join("");
      await render(`<h1>${escape(pageOf(ref))} at every size${report.shard ? ` in shard ${report.shard}` : ""}</h1><div class="row" style="max-width:2900px">${tiles}</div>`, `sheets/${ref.name}`);
    }
  } finally {
    await context.close();
  }
  return fixed;
}

// Where a picture is: the page's address, and the file its address names when the check served the page from a built
// folder, so a tool can replace it. Pictures from elsewhere (another site, data: or blob: addresses) have no file.
function placeOf(target: Target, src: string): { url: string; file?: string } {
  const origin = new URL(target.url).origin;
  if (!target.root) return { url: target.url };
  const url = new URL(src);
  return { url: target.url.slice(origin.length), ...(url.protocol !== "blob:" && url.origin === origin ? { file: join(target.root, decodeURIComponent(url.pathname)) } : {}) };
}

// The images report: each picture too small for where it is drawn, once a page, with its widest drawn width and the
// largest file it needs (at that size's density) across the sizes and themes it was found at, and where to find it: the page's address, a selector, the file it drew and, from
// a built folder, the file on disk. Read from the findings, so it works on a merge too.
function imagesReport(findings: Finding[]): ImageEntry[] {
  const entries = new Map<string, ImageEntry>();
  for (const f of findings) {
    if (!f.image) continue;
    const i = f.image;
    const key = JSON.stringify([f.site, f.page, i.selector, i.src]);
    const size = `${f.width}x${f.height}@${i.density}x ${f.theme}`;
    const known = entries.get(key);
    if (known) {
      known.sizes.push(size);
      known.renderedWidth = Math.max(known.renderedWidth, i.renderedWidth);
      if (i.requiredWidth <= known.requiredWidth) continue;
    }
    entries.set(key, {
      url: i.url ?? f.page,
      site: f.site,
      page: f.page,
      selector: i.selector,
      element: f.element,
      currentSrc: i.src,
      naturalWidth: i.naturalWidth,
      naturalHeight: i.naturalHeight,
      renderedWidth: Math.max(i.renderedWidth, known?.renderedWidth ?? 0),
      dpr: i.density,
      requiredWidth: i.requiredWidth,
      file: i.file ?? null,
      sizes: known ? known.sizes : [size],
    });
  }
  return [...entries.values()].sort((a, b) => a.site.localeCompare(b.site) || a.page.localeCompare(b.page) || b.requiredWidth - a.requiredWidth);
}

async function write(out: string, report: Report) {
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(out, "summary.md"), summary(report));
}

// Merges the out folders of a sharded run into one: every finding, the first close-up of each (at most 40 a page), the
// before and afters, and a contact sheet per page with every size the shards swept. A config gates the findings again.
async function merge({ dirs, out, config, chromium, executablePath }: MergeOptions): Promise<CheckResult> {
  const reports: (Report & { dir: string })[] = [];
  for (const dir of dirs) reports.push({ ...(JSON.parse(await readFile(join(dir, "report.json"), "utf8")) as Report), dir });
  const first = reports[0]!;
  const { sizes, themes } = first;
  const pages = new Map<string, PageRef>();
  for (const r of reports) for (const p of r.pages) pages.set(pageOf(p), p);
  const order = [...pages.keys()].sort();
  const merged: Report = { targets: [...new Set(reports.flatMap((r) => r.targets))], sizes, themes, pages: order.map((key) => pages.get(key)!), findings: [], fixed: [], candidates: [], shots: [], allowances: [] };
  const allowed = new Set<string>();
  for (const a of reports.flatMap((r) => r.allowances)) {
    const key = JSON.stringify([a.site, a.page, a.rules, a.element, a.reason]);
    if (allowed.has(key)) continue;
    allowed.add(key);
    merged.allowances.push(a);
  }
  for (const dir of ["sheets/shots", "findings", "pairs/raw"]) await mkdir(join(out, dir), { recursive: true });
  const rank = (f: Finding) => [sizes.findIndex(([w, h]) => w === f.width && h === f.height), themes.indexOf(f.theme), order.indexOf(pageOf(f))];
  const byRank = (a: Finding, b: Finding) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
  };
  const all = reports.flatMap((r) => r.findings.map((f) => ({ f: { ...f, gated: config ? isGated(config, f.page, f.rule) : f.gated }, dir: r.dir })));
  all.sort((a, b) => byRank(a.f, b.f));
  const pictured = new Set<string>();
  const counts = new Map<string, number>();
  for (const { f, dir } of all) {
    const from = f.closeUp;
    delete f.closeUp;
    const count = counts.get(pageOf(f)) ?? 0;
    if (from && !pictured.has(keyOf(f)) && count < MAX_CLOSE_UPS) {
      pictured.add(keyOf(f));
      counts.set(pageOf(f), count + 1);
      f.closeUp = `findings/${pages.get(pageOf(f))!.name}-${count + 1}.png`;
      await copyFile(join(dir, raw(from)), join(out, raw(f.closeUp)));
    } else delete f.box;
    merged.findings.push(f);
  }
  for (const r of reports) {
    for (const c of r.candidates) {
      const i = merged.candidates.length + 1;
      const moved = { ...c, before: `pairs/raw/${i}-before.png`, after: `pairs/raw/${i}-after.png` };
      await copyFile(join(r.dir, c.before), join(out, moved.before));
      await copyFile(join(r.dir, c.after), join(out, moved.after));
      merged.candidates.push(moved);
    }
    for (const s of r.shots) {
      await copyFile(join(r.dir, "sheets/shots", s.file), join(out, "sheets/shots", s.file));
      merged.shots.push(s);
    }
  }
  merged.shots.sort((a, b) => byRank(a as unknown as Finding, b as unknown as Finding));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    merged.fixed = await compose(browser, out, merged);
  } finally {
    await browser.close();
  }
  await write(out, merged);
  return { ...merged, gated: merged.findings.filter((f) => f.gated) };
}

// Findings grouped by site, page, rule and element, with the sizes each shows at.
function group(findings: Finding[]): (Finding & { sizes: string[] })[] {
  const rows = new Map<string, Finding & { sizes: string[] }>();
  for (const f of findings) {
    const row = rows.get(keyOf(f)) ?? { ...f, sizes: [] };
    if (!row.closeUp && f.closeUp) row.closeUp = f.closeUp;
    const size = `${f.width}×${f.height} ${f.theme}`;
    if (!row.sizes.includes(size)) row.sizes.push(size);
    rows.set(keyOf(f), row);
  }
  return [...rows.values()];
}

// The Markdown report: a row per page with each rule's count, then every finding with the sizes it shows at.
function summary({ findings, fixed, pages, sizes, themes, shard, allowances }: Report): string {
  const rows = group(findings);
  const lines = [
    `### Ouro check: ${pages.length} page${pages.length === 1 ? "" : "s"} at ${sizes.length} size${sizes.length === 1 ? "" : "s"}, ${themes.join(" and ")}, density 2 (1 above 3072px wide)${shard ? `, shard ${shard}` : ""}`,
    "",
    `| | Page | ${RULES.map((rule) => LABELS[rule]).join(" | ")} |`,
    `|---|---|${RULES.map(() => "---").join("|")}|`,
  ];
  for (const ref of pages) {
    const mine = rows.filter((r) => pageOf(r) === pageOf(ref));
    const count = (rule: string) => mine.filter((r) => r.rule === rule).length || "";
    lines.push(`| ${!mine.length ? "✓" : mine.some((r) => r.gated) ? "✗" : "·"} | \`${pageOf(ref)}\` | ${RULES.map(count).join(" | ")} |`);
  }
  lines.push("", "✗ fails; · is waived in ouro-check.json. Each finding has a captioned close-up in `findings/`, and each page a contact sheet in `sheets/`.", "");
  if (fixed.length) lines.push(`Fixed since the earlier report: ${fixed.length}, each with a before and after in \`pairs/\`.`, "");
  if (allowances.length) lines.push(`Opted out on purpose: ${allowances.length}, each with its reason in \`report.json\` (\`allowances\`).`, "");
  if (rows.length) {
    lines.push("<details><summary>Every finding</summary>", "", "| | Page | Rule | Element | At | Example |", "|---|---|---|---|---|---|");
    const cell = (text: string) => text.replaceAll("|", "\\|");
    for (const r of rows) {
      const at = r.sizes.length > 4 ? `${r.sizes.length} sizes, ${r.sizes[0]} to ${r.sizes.at(-1)}` : r.sizes.join(", ");
      lines.push(`| ${r.gated ? "✗" : "·"} | \`${pageOf(r)}\` | ${LABELS[r.rule] ?? r.rule} | ${cell(r.element)} | ${at} | ${cell(r.detail)} |`);
    }
    lines.push("", "</details>");
  }
  return `${lines.join("\n")}\n`;
}

interface Args {
  merge: boolean;
  targets: string[];
  out: string;
  pages?: string | undefined;
  sizes: [number, number][];
  themes: string[];
  shard: [number, number];
  before?: string | undefined;
  config?: string | undefined;
  axe: boolean;
  measured: boolean;
  readyEvents: string[];
  imagesReport?: string | undefined;
}

const ABOUT = [
  "ouro-check: checks every page at every screen size, light and dark, for overlap, sideways scroll, clipped text, broken, blurry and stretched pictures and videos, pictures that fade into the page, pages that fail to load or draw, serious accessibility problems, and design problems: a banner where content belongs, a cramped heading, a frame inside a frame, a recording's own corner inside its frame, too many text sizes, weights or shadows, grey text on colour and a heading larger than the one above it; text that leaks a value (undefined, NaN, [object Object], an id, a translation key, TODO) or shows a time no one should read (Invalid Date, 1 January 1970, a raw timestamp); errors and warnings in the console and requests to the page's own server that fail; content the screen cuts off, the same control twice in view and a region that scrolls by a few pixels; a control that shows no keyboard focus and a light surface left on a dark page; a disabled control with no reason given; text that wraps by accident (a lone last word, a tall h1, a one-word line in big text, a heading broken by hand or held narrow) and hero art with no night twin; and long lines only where ouro-check.json declares a measure.",
  "A site on the web must move http:// to https:// and ask for HSTS. It measures layout shift, first content, the presses the app lists and jank as it walks each page (hovering cards, opening popups, scrolling and panning) against their budgets, and finds a control the first frames draw that a later frame swaps for another, with no input. It writes report.json, summary.md, a contact sheet per page and a captioned close-up per finding. merge joins the out folders of a sharded run into one.",
];

const REPORT_FLAGS: Readonly<Record<string, FlagSpec>> = Object.freeze({
  out: { type: "string", placeholder: "<folder>", description: "Where the report goes (default ouro-check)." },
  config: { type: "string", placeholder: "<file>", description: "The waivers and budgets (default ouro-check.json, when it exists)." },
  "images-report": {
    type: "string",
    placeholder: "<file>",
    description:
      "Also write, as JSON, each picture too small for where it is drawn: its page, a selector, the file it drew, that file's pixels, its drawn width, the density and the width it needs.",
  },
});

const CHECK_FLAGS: Readonly<Record<string, FlagSpec>> = Object.freeze({
  pages: { type: "string", placeholder: "<glob>", description: "Only the pages of the built folder that the glob matches, such as one section's pages." },
  sizes: { type: "list", placeholder: "<WxH,…>", description: "The screen sizes (default: from a phone to a wide desktop, and short landscape screens)." },
  themes: { type: "list", placeholder: "<light,dark>", description: "The colour schemes (default both)." },
  shard: { type: "string", placeholder: "<k/n>", description: "This job's share, the kth of n parallel jobs; merge their out folders after." },
  before: { type: "string", placeholder: "<report.json>", description: "An earlier report, to show a before and after of what was fixed since." },
  "no-axe": { type: "boolean", description: "Skip axe-core." },
  "no-measured": { type: "boolean", description: "Skip the measured rules, and press nothing." },
  "ready-event": { type: "string", repeat: true, placeholder: "<name>", description: "An event the page fires once it has drawn, besides ouro:ready." },
  ...REPORT_FLAGS,
});

const URL_TARGET = /^https?:\/\//;

const isFolder = (path: string) => stat(path).then((s) => s.isDirectory(), () => false);

const refusal = (code: string, thing: string, problem: string, fix: string | null) => new AxError({ code, exit: EXIT.usage, thing, problem, fix });

// The command as typed, with some of its input replaced: the fix a refusal prints.
const fixFor = (cli: Cli, cmd: CommandDef, input: Input, changes: Input) => commandLine([cli.name, ...toArgv(cli, cmd, { ...input, ...changes }).argv]);

function sizesOf(cli: Cli, cmd: CommandDef, input: Input): [number, number][] {
  const words = input["sizes"] as readonly string[] | undefined;
  if (words === undefined) return SIZES;
  const matches = words.map((word) => /^(\d+)x(\d+)$/.exec(word));
  const bad = words.find((_, i) => matches[i] === null);
  if (bad !== undefined || words.length === 0)
    throw refusal("bad-value", "check --sizes", `takes WxH pairs such as 390x844,1440x900, not "${bad ?? ""}"`, fixFor(cli, cmd, input, { sizes: ["390x844", "1440x900"] }));
  return matches.map((match) => [Number(match![1]), Number(match![2])] as [number, number]);
}

function themesOf(cli: Cli, cmd: CommandDef, input: Input): string[] {
  const themes = (input["themes"] as readonly string[] | undefined) ?? ["light", "dark"];
  const bad = themes.find((theme) => theme !== "light" && theme !== "dark");
  if (bad !== undefined || themes.length === 0)
    throw refusal("bad-value", "check --themes", `takes light, dark or both (light,dark), not "${bad ?? ""}"`, fixFor(cli, cmd, input, { themes: ["light", "dark"] }));
  return [...themes];
}

function shardOf(cli: Cli, cmd: CommandDef, input: Input): [number, number] {
  const text = input["shard"] as string | undefined;
  if (text === undefined) return [1, 1];
  const match = /^(\d+)\/(\d+)$/.exec(text);
  const [k, n] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
  if (!(n >= 1 && k >= 1 && k <= n)) throw refusal("bad-value", "check --shard", `takes k/n, such as 1/4, not "${text}"`, fixFor(cli, cmd, input, { shard: "1/4" }));
  return [k, n];
}

// The arguments a run takes, each checked; a value that is refused names the command as typed, with its fix.
function argsOf(cli: Cli, cmd: CommandDef, input: Input): Args {
  const text = (name: string) => input[name] as string | undefined;
  const merging = cmd.name === "merge";
  const targets = (input[merging ? "folder" : "target"] as readonly string[] | undefined) ?? [];
  return {
    merge: merging,
    targets: [...targets],
    out: text("out") ?? "ouro-check",
    pages: text("pages"),
    sizes: sizesOf(cli, cmd, input),
    themes: themesOf(cli, cmd, input),
    shard: shardOf(cli, cmd, input),
    before: text("before"),
    config: text("config"),
    axe: input["no-axe"] !== true,
    measured: input["no-measured"] !== true,
    readyEvents: [...((input["ready-event"] as readonly string[] | undefined) ?? [])],
    imagesReport: text("images-report"),
  };
}

// A mistyped command word is a target, so it names the word it is closest to.
function targetRefusal(cli: Cli, target: string): AxError {
  const word = didYouMean(target, ["merge"]);
  return refusal("not-a-target", "check", `"${target}" is not a folder or an http(s) URL`, word ? `${cli.name} merge <out folders>` : `${cli.name} <built folder or URL>`);
}

// The command line as the kit reads it: a run's arguments, checked. A help request reads the defaults.
function parseArgs(argv: string[]): Args {
  const cli = checkTool({ cwd: process.cwd(), env: {}, log: console.log, error: console.error });
  const parsed = parse(cli, argv);
  return parsed.kind === "run" ? argsOf(cli, parsed.command, parsed.input) : argsOf(cli, cli.defaultCommand!, {});
}

interface Env {
  cwd: string;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  error: (line: string) => void;
  /** The folders Playwright and axe-core are found from: the app's folder, then this kit's, unless given. */
  from?: string[];
}

// A module the app has (resolved from its folder) or this kit's own; null when neither has it.
function load(name: string, from: string[]): string | null {
  for (const base of from) {
    try {
      return createRequire(join(base, "noop.js")).resolve(name);
    } catch {
      // Not there; try the next folder.
    }
  }
  return null;
}

async function readJson<T>(file: string): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (problem) {
    throw refusal("unreadable-file", "check", `reading ${file} stopped the check: ${(problem as Error).message}`, "fix the file or its path, then run the check again");
  }
}

// What is wrong with a config's press and state settings, which JSON leaves unchecked: a string would read as its letters.
function configProblem({ press, pressRepeat, states, waive }: Gate): string | null {
  const waived = Object.entries(waive ?? {}).find(([, rules]) => Object.hasOwn(Object(rules), "blurry-image"));
  if (waived)
    return `"waive" > "${waived[0]}" waives blurry-image, which cannot be waived: remove it, and give each picture it reports a larger source, or a srcset whose largest file covers its drawn width at 2x.`;
  if (press !== undefined && !(Array.isArray(press) && press.every((selector) => typeof selector === "string" && selector.trim() !== ""))) return '"press" takes a list of CSS selectors, such as ["[role=tab]"].';
  if (pressRepeat !== undefined && !(Number.isInteger(pressRepeat) && pressRepeat >= 1)) return '"pressRepeat" takes a whole number of presses, 1 or more.';
  const listOf = (steps: unknown) => Array.isArray(steps) && steps.length > 0 && steps.every((step) => typeof step === "string" && step.trim() !== "");
  const named = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  if (states !== undefined && !(named(states) && Object.values(states).every((page) => named(page) && Object.values(page).every(listOf))))
    return '"states" takes pages, each with its states\' names and the controls to press to reach them, such as {"/": {"a chat open": ["text=Launch planning"]}}.';
  return null;
}

// The check or the merge: its report, the step summary and the images report, then the outcome. Gated findings are the
// person's to fix, so they are the needs-human outcome, which exits 3.
async function runCheck(context: Env, cli: Cli, cmd: CommandDef, input: Input, json: boolean): Promise<Outcome> {
  const { cwd, env } = context;
  // Under --json, stdout holds the outcome alone, so the progress lines go to stderr.
  const log = json ? context.error : context.log;
  const args = argsOf(cli, cmd, input);
  const merging = args.merge;
  const from = context.from ?? [cwd, dirname(fileURLToPath(import.meta.url))];
  for (const target of args.targets) if (!merging && !URL_TARGET.test(target) && !(await isFolder(resolve(cwd, target)))) throw targetRefusal(cli, target);
  const playwright = env.PLAYWRIGHT_MODULE ?? ["playwright", "playwright-core"].map((name) => load(name, from)).find(Boolean);
  if (!playwright) throw refusal("no-playwright", "check", "needs Playwright", "install playwright (npm i -D playwright), or set PLAYWRIGHT_MODULE to it");
  const chromium = (createRequire(import.meta.url)(playwright) as { chromium: BrowserType }).chromium;
  const executable = env.BROWSER_EXECUTABLE ? { executablePath: env.BROWSER_EXECUTABLE } : {};
  const configFile = resolve(cwd, args.config ?? "ouro-check.json");
  const hasConfig = args.config !== undefined || (await readFile(configFile).then(() => true, () => false));
  const config: Gate = hasConfig ? await readJson<Gate>(configFile) : {};
  const wrong = configProblem(config);
  if (wrong) throw refusal("bad-config", configFile, wrong, null);
  if (config.measure !== undefined && (typeof config.measure !== "object" || config.measure === null || Array.isArray(config.measure)))
    throw refusal("bad-config", configFile, '"measure" maps page globs and CSS selectors to measures', 'write it as an object, such as { "**": "100 chars" }');
  const unreadable = Object.entries(config.measure ?? {}).find(([, measure]) => typeof measure !== "string" || !MEASURE.test(measure.trim()));
  if (unreadable)
    throw refusal("bad-config", configFile, `the measure for "${unreadable[0]}" is ${JSON.stringify(unreadable[1])}`, 'give a number of px, ch or chars, such as "800px", "75ch" or "100 chars"');
  // The check itself failing (no browser, a full disk) is no finding: it exits 1, never 3, which means "fix these".
  const out = resolve(cwd, args.out);
  try {
    let result: CheckResult;
    if (merging) {
      const dirs = args.targets.map((dir) => resolve(cwd, dir));
      for (const dir of dirs) await readJson<Report>(join(dir, "report.json"));
      result = await merge({ dirs, out, ...(hasConfig ? { config } : {}), chromium, ...executable });
    } else {
      let axe: string | false = false;
      if (args.axe) {
        const file = env.AXE_CORE ?? load("axe-core/axe.min.js", from);
        if (!file) throw refusal("no-axe", "check", "runs axe-core", "install it (npm i -D axe-core), set AXE_CORE to axe.min.js, or pass --no-axe");
        axe = await readFile(file, "utf8");
      }
      const before = args.before === undefined ? { findings: [] } : await readJson<{ findings: Finding[] }>(resolve(cwd, args.before));
      result = await check({
        targets: args.targets.map((t) => (URL_TARGET.test(t) ? t : resolve(cwd, t))),
        out,
        ...(args.pages === undefined ? {} : { pages: args.pages }),
        sizes: args.sizes,
        themes: args.themes,
        shard: args.shard,
        before: before.findings,
        ...(args.before === undefined ? {} : { beforeDir: dirname(resolve(cwd, args.before)) }),
        config,
        axe,
        measured: args.measured,
        readyEvents: args.readyEvents,
        chromium,
        ...executable,
        log,
      });
      if (!result.pages.length && args.shard[1] === 1)
        throw refusal("no-pages", "check", `No pages to check in ${args.targets.join(", ")}${args.pages === undefined ? "" : ` matching ${args.pages}`}`, null);
    }
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summary(result));
    const lines: string[] = [];
    if (args.imagesReport !== undefined) {
      const file = resolve(cwd, args.imagesReport);
      await mkdir(dirname(file), { recursive: true });
      const images = imagesReport(result.findings);
      await writeFile(file, `${JSON.stringify({ images }, null, 2)}\n`);
      lines.push(`Images report: ${images.length} picture(s) too small for where they are drawn, in ${relative(cwd, file)}`);
    }
    const failing = group(result.gated);
    lines.push(`\n${group(result.findings).length} finding(s), ${failing.length} gated, ${result.fixed.length} fixed since --before. Report: ${relative(cwd, join(out, "report.json"))}`);
    return outcome({ action: cmd.name, state: failing.length ? "needs-human" : "done", summary: lines.join("\n") });
  } catch (problem) {
    if (isAxError(problem)) throw problem;
    const message = (problem as Error).message;
    if ((problem as { usage?: boolean }).usage) throw refusal("bad-config", configFile, message, null);
    throw new AxError({ code: "check-stopped", exit: EXIT.error, thing: "check", problem: `stopped before it finished: ${message}`, fix: null });
  }
}

// The tool: `check` is the default command, which runs for any leading word that is not `merge`; a target named like
// `merge` goes after `--`.
function checkTool(context: Env): Cli {
  const checkCommand: CommandDef<Outcome> = defineCommand<Outcome>({
    name: "check",
    summary: "Checks every page of a built folder or a URL at every screen size, light and dark, and writes the report.",
    effect: "private",
    examples: ["ouro-check site/dist --pages /docs/button/ --no-axe"],
    args: [{ name: "target", description: "A built folder or an http(s) URL to check.", required: true, rest: "list", missing: "Name a URL or a built folder to check." }],
    flags: CHECK_FLAGS,
    output: "an outcome: state needs-human when gated findings remain (exit 3), else done; its summary names report.json",
    run: (input, ctx) => runCheck(context, cli, checkCommand, input, ctx.json),
  });
  const mergeCommand: CommandDef<Outcome> = defineCommand<Outcome>({
    name: "merge",
    summary: "Joins the out folders of a sharded run into one report.",
    effect: "private",
    examples: ["ouro-check merge ouro-check-1 ouro-check-2 --out ouro-check"],
    args: [{ name: "folder", description: "An out folder of a sharded run, with its report.json.", required: true, rest: "list", missing: "Name the out folders to merge." }],
    flags: REPORT_FLAGS,
    output: "an outcome: state needs-human when gated findings remain (exit 3), else done; its summary names report.json",
    run: (input, ctx) => runCheck(context, cli, mergeCommand, input, ctx.json),
  });
  const cli: Cli = defineCli({
    name: "ouro-check",
    about: ABOUT,
    exits: defineExitCodes([...BASE_EXIT_CODES, FINDINGS_EXIT_CODE]),
    outcomeExits: { ...DEFAULT_OUTCOME_EXITS, "needs-human": "findings" },
    command: checkCommand,
    commands: [mergeCommand],
  });
  return cli;
}

// The command: returns the exit code. The kit parses the arguments, prints the outcome or the one error line, and exits.
async function main(argv: readonly string[], context: Env): Promise<number> {
  return runCli(checkTool(context), argv, {
    stdout: {
      write: (text) => {
        context.log(text.replace(/\n$/, ""));
        return true;
      },
    },
    stderr: {
      write: (text) => {
        context.error(text.replace(/\n$/, ""));
        return true;
      },
    },
  });
}

/* node:coverage disable */
// What check.ts runs as a command: quiet pipes, then the exit code the command returns.
async function runScript(argv: readonly string[]): Promise<void> {
  quietPipes(process);
  process.exitCode = await main(argv, { cwd: process.cwd(), env: process.env, log: console.log, error: console.error });
}
/* node:coverage enable */
