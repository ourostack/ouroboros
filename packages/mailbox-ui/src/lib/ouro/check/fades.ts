export { FADE_FIX, findFades, main, SCANNED, SKIPPED, scan, WASH_FIX };
export type { Fade };

import { realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT } from "./check.ts";

// The fade check: a picture never fades into the page. It reads an app's source and finds the two usual ways a picture
// is made to dissolve, in stylesheets, Tailwind classes and style objects alike: every gradient used as a mask, and every
// wash, a gradient that reaches transparent laid over a picture:
//
//   node lib/ouro/check/fades.ts <folder | file>…
//
// A wash is a gradient that reaches transparent on a layer over the picture, a `::before` or `::after` or an absolutely
// positioned or fixed box other than a hairline, in a file that draws a picture (an `<img>`, `<picture>`, `<video>` or a
// `url()` other than a font's, a stylesheet's or a cursor's), or a gradient whose
// name says what it is: a wash, scrim, fade, veil or haze. A gradient with no such role, a painted sky or a glow, passes.
// A fade over text or controls rather than a picture (a row that scrolls sideways, a folded paragraph) stays when the
// line it is on, or the comment just above it, says why: `fade-ok: <reason>`. A marker without a reason does not count.
// Exits as check.ts does (EXIT): 0 none found, 2 usage, 3 findings; 1 when a file cannot be read.

interface Fade {
  file: string;
  line: number;
  /** A gradient mask, or a wash: a gradient that reaches transparent over a picture. */
  kind: "mask" | "wash";
  declaration: string;
}

// The files read, by extension, and the folders never entered: dependencies, build output and hidden folders.
const SCANNED = [".css", ".scss", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".astro", ".html", ".svelte", ".vue"];
const SKIPPED = ["node_modules", "dist", "build", "storybook-static", "coverage"];
const FADE_FIX =
  "end the picture on a hard edge, or put it on a solid band; if this mask fades text or controls rather than a picture, mark it `fade-ok: <why>`";
const WASH_FIX =
  "take the wash off the picture, and put words that need it on a solid band; if this gradient lies over no picture, mark it `fade-ok: <why>`";

// Where a mask is declared, and how its value is read. `css` is a declaration (`mask-image: …`, up to its `;`); `js` a
// style object's key or a style property set (`maskImage: …`, `style.maskImage = …`, up to the next comma at its own
// level, or a line break that no operator carries over); `bracket` a Tailwind arbitrary property
// or value (`[mask-image:…]`, `mask-[…]`, up to its `]`); `utility` one of Tailwind's own gradient mask utilities,
// which are a gradient by name.
const DECLARATIONS: { pattern: RegExp; read: "css" | "js" | "bracket" | "utility" }[] = [
  { pattern: /(?<![\w$[-])(?:-webkit-)?mask(?:-image)?\s*:(?!:)/g, read: "css" },
  { pattern: /(?<![\w$])(?:[Ww]ebkit)?[Mm]ask(?:Image)?\s*(?::(?!:)|=(?!=))/g, read: "js" },
  { pattern: /["'](?:-webkit-)?mask(?:-image)?["']\s*[:,]/g, read: "js" },
  { pattern: /\[(?:-webkit-)?mask(?:-image)?:/g, read: "bracket" },
  { pattern: /(?<![\w$[/.-])mask-\[/g, read: "bracket" },
  { pattern: /(?<![\w$[/.-])-?mask-(?:linear|radial|conic|[tblrxy]-(?:from|to))(?![\w])[^\s"'`]*/g, read: "utility" },
];
const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const QUOTES = new Set(['"', "'", "`"]);
// An operator that starts the next line and so carries a script's value on to it.
const CARRIED = /\s*[?:|&+]/y;

// The value from `start`: up to what ends it at its own level (`stops`). Brackets nest and quotes hold their contents
// whole, except that in a declaration (`css`) a quote at its own level ends the value, as the end of a style attribute
// or of the string the declaration is in does. In a script a string never follows a word or a `)` directly, so a quote
// there is a style attribute's end too (`style="mask: url(a.svg) center"`). A script's value also ends at a line break
// once some of it has been read, unless an operator at the end of that line or the start of the next carries it on, as
// in a ternary.
function readValue(text: string, start: number, read: "css" | "js" | "bracket"): string {
  const stops = read === "css" ? ";{}" : read === "js" ? ",;})]" : "]";
  const closing: string[] = [];
  let i = start;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (closing.length === 0) {
      if (stops.includes(c) || (read === "css" && QUOTES.has(c))) break;
      if (read === "js" && (c === '"' || c === "'") && /[\w)]\s*$/.test(text.slice(start, i))) break;
      if (read === "js" && c === "\n") {
        const before = text.slice(start, i);
        CARRIED.lastIndex = i + 1;
        if (before.trim() !== "" && !/[?:|&+]\s*$/.test(before) && !CARRIED.test(text)) break;
      }
    }
    const close = OPENERS[c];
    if (QUOTES.has(c)) {
      const end = text.indexOf(c, i + 1);
      i = end < 0 ? text.length : end;
    } else if (close) closing.push(close);
    else if (c === closing.at(-1)) closing.pop();
  }
  return text.slice(start, i);
}

// Whether a line opts its fade out with a reason: `fade-ok:` and words after it, other than a comment's closing marks.
const optsOut = (line: string) => {
  const marker = /fade-ok:([^\r\n]*)/.exec(line);
  return marker !== null && /\p{L}/u.test(marker[1]!.replace(/\*\/|-->|\}+/g, ""));
};

// A line that is only a comment, or starts one.
const commentOnly = (line: string) => /^\s*(?:\/\/|\/\*|\*|<!--|\{\/\*)/.test(line);

// Whether the comment just above line `index` (0-based) says why: any line of the comment lines right above it, `//`
// lines or a block comment, its continuation lines included. A marker after code belongs to that line's own mask, so a
// line of code, or a comment after code, ends the search.
function markedAbove(lines: string[], index: number): boolean {
  let inBlock = false;
  for (let k = index - 1; k >= 0; k--) {
    const line = lines[k]!;
    if (!inBlock && /(?:\*\/|-->)\s*\}?\s*$/.test(line)) inBlock = true;
    else if (!inBlock && !commentOnly(line)) return false;
    const opener = line.search(/\/\*|<!--/);
    if (inBlock && opener >= 0) {
      inBlock = false;
      if (line.slice(0, opener).replace(/\{\s*$/, "").trim() !== "") return false;
    }
    if (optsOut(line)) return true;
  }
  return false;
}

// A gradient that reaches transparent somewhere: a `transparent` stop, a colour with no alpha (`/ 0`, `rgba(…, 0)`,
// `#0000`), or a Tailwind gradient with a stop left out, which Tailwind draws as transparent.
const CLEAR = /(?<![a-z-])transparent(?![\w-])|\/\s*0(?:\.0*)?%?\s*\)|(?:rgba|hsla)\([^()]*,\s*0(?:\.0*)?%?\s*\)|#(?:[\da-f]{3}0|[\da-f]{6}00)(?![\da-f])/i;
const GRADIENT = /(?<![\w-])(?:repeating-)?(?:linear|radial|conic)-gradient\(/gi;
const UTILITY = /(?<![\w-])(?:[\w-]+:)*bg-(?:gradient-to-[trbl]{1,2}|linear-(?:to-[trbl]{1,2}|\d+|\[)|radial|conic)(?![\w-])[^\s"'`]*/g;
const STOP = (stop: string) => new RegExp(`(?<![\\w-])(?:[\\w-]+:)*${stop}-(?!\\d+%)[^\\s"'\`]+`, "g");
const CLEAR_STOP = /^(?:[\w-]+:)*(?:from|via|to)-(?:transparent|[^\s/]+\/0)$/;
// A layer over something: a pseudo-element, or an absolutely positioned or fixed box, by its CSS or its Tailwind class
// (not a value, such as `background-attachment: fixed`); and a hairline, a layer a pixel thick, which covers nothing.
const OVER = /::?(?:before|after)\b|(?<![\w-])(?:before|after):|(?<![\w-])(?<!:\s*)(?:[\w-]+:)*(?:absolute|fixed)(?![\w-]|\s*[;,)}])|position\s*:\s*["'`]?(?:absolute|fixed)/i;
const HAIRLINE = /(?<![\w-])(?:[\w-]+:)*[hw]-(?:px|\[1px\])(?![\w-])|(?:height|width)\s*:\s*["'`]?1px/i;
// A picture in the file: an image, a picture, a video or a `url()` that is not an SVG reference, a font, a stylesheet
// or a cursor.
const PICTURE = /<(?:img|picture|video|Image)\b|(?<![\w-])(?<!@import\s*|(?:src|cursor)\s*:\s*)url\(\s*(?!["']?#)/;
const WASH_WORDS = new Set(["wash", "washes", "scrim", "scrims", "fade", "fades", "veil", "veils", "haze", "hazes"]);
// Whether a name says it washes: one of its words, split at hyphens, underscores and capitals, is one of WASH_WORDS.
const named = (name: string) => name.split(/[^A-Za-z]+|(?<=[a-z])(?=[A-Z])/).some((word) => WASH_WORDS.has(word.toLowerCase()));

// The quoted string on `at`'s line that `at` sits in, a class list or a style value; empty when it sits in none.
function quoted(text: string, at: number): string {
  const start = text.lastIndexOf("\n", at - 1) + 1;
  let open = -1;
  for (let i = start; i < at; i++) {
    if (open < 0 ? QUOTES.has(text[i]!) : text[i] === text[open]) open = open < 0 ? i : -1;
  }
  if (open < 0) return "";
  const close = text.indexOf(text[open]!, at);
  return text.slice(open + 1, close < 0 ? text.length : close);
}

// The rule or object `at` sits in: the innermost braces around it, read no further than 1500 characters each way,
// with the selector or name before them, and the 0-based line its opening brace is on.
function blockAround(text: string, at: number): { head: string; body: string; line: number } | undefined {
  let open = -1;
  for (let i = at - 1, depth = 0; i >= Math.max(0, at - 1500); i--) {
    if (text[i] === "}") depth++;
    else if (text[i] === "{" && depth-- === 0) {
      open = i;
      break;
    }
  }
  if (open < 0) return undefined;
  let close = -1;
  for (let i = open + 1, depth = 0; i < Math.min(text.length, at + 1500); i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && depth-- === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return undefined;
  const before = text.slice(Math.max(0, open - 300), open);
  const head = before.slice(Math.max(...["}", "{", ";", "*/"].map((end) => before.lastIndexOf(end) + end.length)));
  return { head, body: text.slice(open + 1, close), line: text.slice(0, open).split("\n").length - 1 };
}

// The gradient that starts at `at`, up to the parenthesis that closes the one at `open`, or the rest of the file.
function closed(text: string, at: number, open: number): string {
  let i = open;
  for (let depth = 1; i < text.length && depth > 0; i++) depth += text[i] === "(" ? 1 : text[i] === ")" ? -1 : 0;
  return text.slice(at, i);
}

// Whether line `index` (0-based) opts out, on the line itself or in the comment just above it.
const optedOut = (lines: string[], index: number) => optsOut(lines[index]!) || markedAbove(lines, index);

// Every gradient mask and every wash in `text`, by line, that neither its line nor the comment just above it opts out;
// a wash in a rule may say why at the rule's start too.
function findFades(text: string, file: string): Fade[] {
  const lines = text.split(/\r?\n/);
  const lineOf = (at: number) => text.slice(0, at).split("\n").length;
  const found = new Map<number, Fade>();
  // Where each mask's value lies, opted out or not, so that its gradient is never read again as a wash.
  const masked: [number, number][] = [];
  const add = (line: number, kind: Fade["kind"], declaration: string) => {
    const short = declaration.replace(/\s+/g, " ").trim();
    found.set(line, { file, line, kind, declaration: short.length > 160 ? `${short.slice(0, 159)}…` : short });
  };
  for (const { pattern, read } of DECLARATIONS) {
    for (const match of text.matchAll(pattern)) {
      const at = match.index;
      const end = at + match[0].length;
      const value = read === "utility" ? "" : readValue(text, end, read);
      if (read !== "utility" && !/gradient\(/i.test(value)) continue;
      masked.push([at, end + value.length]);
      const line = lineOf(at);
      if (found.has(line) || optedOut(lines, line - 1)) continue;
      add(line, "mask", `${match[0]}${value}${read === "bracket" ? "]" : ""}`);
    }
  }
  const picture = PICTURE.test(text);
  for (const match of text.matchAll(GRADIENT)) {
    const at = match.index;
    const gradient = closed(text, at, at + match[0].length);
    const line = lineOf(at);
    if (masked.some(([from, to]) => at >= from && at < to) || found.has(line) || !CLEAR.test(gradient)) continue;
    const start = text.lastIndexOf("\n", at - 1) + 1;
    const lead = text.slice(start, at);
    const block = blockAround(text, at);
    const string = quoted(text, at);
    const lineText = lines[line - 1]!;
    const layer = `${block?.head ?? ""}\n${block?.body ?? ""}\n${lineText}`;
    const over = OVER.test(layer) && !HAIRLINE.test(layer);
    if (!(named(`${block?.head ?? ""} ${lead} ${string}`) || (over && picture))) continue;
    if (optedOut(lines, line - 1) || (block !== undefined && optedOut(lines, block.line))) continue;
    add(line, "wash", gradient);
  }
  for (const match of text.matchAll(UTILITY)) {
    const line = lineOf(match.index);
    if (found.has(line)) continue;
    const classes = quoted(text, match.index) || lines[line - 1]!;
    const stops = ["from", "via", "to"].map((stop) => [...classes.matchAll(STOP(stop))].map((token) => token[0]));
    const clear = stops[0]!.length === 0 || stops[2]!.length === 0 || stops.flat().some((token) => CLEAR_STOP.test(token));
    if (!clear || !(named(classes) || (OVER.test(classes) && !HAIRLINE.test(classes) && picture)) || optedOut(lines, line - 1)) continue;
    add(line, "wash", [match[0], ...stops.flat()].join(" "));
  }
  return [...found.values()].sort((a, b) => a.line - b.line);
}

// The files under each path (or the path itself, when it is a file), sorted, read and checked.
async function scan(paths: string[], cwd: string): Promise<Fade[]> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIPPED.includes(entry.name)) await walk(path);
      } else if (SCANNED.includes(extname(entry.name))) files.push(path);
    }
  };
  for (const path of paths) {
    const full = resolve(cwd, path);
    if ((await stat(full)).isDirectory()) await walk(full);
    else files.push(full);
  }
  const fades: Fade[] = [];
  for (const file of [...new Set(files)].sort()) fades.push(...findFades(await readFile(file, "utf8"), relative(cwd, file)));
  return fades;
}

const USAGE = `Usage: node lib/ouro/check/fades.ts <folder | file>…

Finds every gradient used as a mask, and every wash (a gradient that reaches transparent on a layer over a picture, or
named a wash, scrim, fade, veil or haze), in the source under each folder (its stylesheets, Tailwind classes and style
objects; not node_modules, build output or hidden folders), so that no picture fades into the page. Where one fades
text or controls rather than a picture, say why on its line or in the comment just above it: fade-ok: <reason>.

Exit codes: 0 none found, 1 error (a file could not be read), 2 usage, 3 findings to fix.`;

interface Env {
  cwd: string;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  error: (line: string) => void;
}

// The command: returns the exit code.
async function main(argv: string[], { cwd, env, log, error }: Env): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    log(USAGE);
    return EXIT.ok;
  }
  const option = argv.find((arg) => arg.startsWith("-"));
  if (option !== undefined || !argv.length) {
    error(`${option === undefined ? "Name a folder or a file to check." : `Unknown option ${option}.`}\n\n${USAGE}`);
    return EXIT.usage;
  }
  for (const path of argv) {
    if (!(await stat(resolve(cwd, path)).then(() => true, () => false))) {
      error(`${path} is not a folder or a file.\n\n${USAGE}`);
      return EXIT.usage;
    }
  }
  let fades: Fade[];
  try {
    fades = await scan(argv, cwd);
  } catch (problem) {
    error(`The fade check stopped before it finished: ${(problem as Error).message}`);
    return EXIT.error;
  }
  for (const fade of fades) {
    const fix = fade.kind === "mask" ? FADE_FIX : WASH_FIX;
    log(`${fade.file}:${fade.line}: ${fade.declaration}\n  Fix: ${fix}.`);
    if (env.GITHUB_ACTIONS === "true") log(`::error file=${fade.file},line=${fade.line},title=Picture fade::${fade.declaration}: ${fix}.`);
  }
  log(fades.length ? `\n${fades.length} picture fade${fades.length === 1 ? "" : "s"} to fix.` : "No picture fades without a fade-ok reason.");
  return fades.length ? EXIT.findings : EXIT.ok;
}

/* node:coverage disable */
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2), { cwd: process.cwd(), env: process.env, log: console.log, error: console.error });
}
/* node:coverage enable */
