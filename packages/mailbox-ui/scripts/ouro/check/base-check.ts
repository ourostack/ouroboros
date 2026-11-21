import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Ouro base check: whether the app's stylesheet still has ouro-base as the Ouro UI release it pins has it, so no copy
// of an older ouro-base outlives the release that changed it. It reads the pin (.github/ouro-hx-installed.json, which
// Ouro Current keeps), the stylesheet components.json names, and ouro-base at that tag: the app's own copy, which the
// stylesheet imports (`@import "./ouro/ouro-base.css"`), or the tag's file from GitHub when the stylesheet still holds
// ouro-base's rules itself.
//
//   node scripts/ouro/check/base-check.ts [<app folder>] [--source <ouro-base.css at the pinned tag>]
//
// It fails on drift, with each finding on a line of its own:
//
//   edited     ouro-base's own file is not the pinned tag's (its hash is not the one the pin records)
//   override   the stylesheet sets something ouro-base sets, to another value, and the override list does not name it
//   copy       the stylesheet repeats ouro-base's own value beside the import, so a later release's change would not
//              reach it
//   missing    a stylesheet that holds ouro-base's rules lacks one of them
//   stale      the override list names something the stylesheet no longer overrides
//
// The override list is .github/ouro-base-overrides.json, beside the pin: each key is what the stylesheet overrides, as
// a finding names it (`:root --ouro-layer`, `@theme inline --radius-md`, `@keyframes ouro-spin`), and its value is why.
// --input and --radius are the app theme's whenever it sets them, so they never need a line.

/** What ouro-base gives only an app whose theme lacks it: the theme's whenever it sets them. */
const THEME_OWNED = new Set(["--input", "--radius"]);
const PIN = ".github/ouro-hx-installed.json";
const OVERRIDES = ".github/ouro-base-overrides.json";
const RAW = "https://raw.githubusercontent.com/ourostack/ouro-ui";
const SOURCE = "registry/ouro/theme/ouro-base.css";

export interface BaseFinding {
  kind: "edited" | "override" | "copy" | "missing" | "stale";
  key: string;
  message: string;
}

/** A stylesheet's declarations by key (`@supports not (…) :root --x`, a selector list split into its selectors), and its keyframes. */
export interface Rules {
  decls: Map<string, string>;
  keyframes: Map<string, string>;
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** The selectors of a list, split at its top-level commas. */
function selectors(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < prelude.length; index += 1) {
    const char = prelude[index];
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      out.push(prelude.slice(from, index));
      from = index + 1;
    }
  }
  out.push(prelude.slice(from));
  return out.map(collapse).filter(Boolean);
}

/**
 * The stylesheet's rules: a declaration keyed by its at-rules (`@layer base` left out, as a rule inside it counts the
 * same) and its selector, and a `@keyframes` whole, wherever it sits. Comments and strings are read as such.
 */
export function readRules(text: string): Rules {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const decls = new Map<string, string>();
  const keyframes = new Map<string, string>();
  const stack: string[] = [];
  let segment = 0;
  let quote: string | null = null;
  let parens = 0;
  let frames: { name: string; depth: number; from: number } | null = null;
  const declare = (raw: string) => {
    const match = /^\s*(--[\w-]+|-?[A-Za-z][\w-]*)\s*:([\s\S]*)$/.exec(raw);
    if (!match || stack.length === 0 || frames) return;
    const prelude = stack.at(-1)!;
    const wrappers = stack.slice(0, -1).filter((at) => at !== "@layer base");
    const names = prelude.startsWith("@") ? [prelude] : selectors(prelude);
    for (const name of names) decls.set([...wrappers, name, match[1]].join(" "), collapse(match[2]!));
  };
  for (let index = 0; index < src.length; index += 1) {
    const char = src[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") parens += 1;
    else if (char === ")") parens = Math.max(0, parens - 1);
    else if (parens > 0) continue;
    else if (char === ";") {
      declare(src.slice(segment, index));
      segment = index + 1;
    } else if (char === "{") {
      const prelude = collapse(src.slice(segment, index));
      if (!frames && prelude.startsWith("@keyframes")) frames = { name: prelude, depth: stack.length, from: index + 1 };
      stack.push(prelude);
      segment = index + 1;
    } else if (char === "}") {
      declare(src.slice(segment, index));
      stack.pop();
      if (frames && stack.length === frames.depth) {
        keyframes.set(frames.name, collapse(src.slice(frames.from, index)).replace(/\s*([{};:])\s*/g, "$1").replace(/;}/g, "}"));
        frames = null;
      }
      segment = index + 1;
    }
  }
  return { decls, keyframes };
}

/** The path the stylesheet imports ouro-base by, or null. */
export function baseImport(text: string): string | null {
  const bare = text.replace(/\/\*[\s\S]*?\*\//g, "");
  return /@import\s+(?:url\(\s*)?(["'])([^"']*\bouro-base\.css)\1/.exec(bare)?.[2] ?? null;
}

/**
 * The findings for a stylesheet against ouro-base at its pinned tag. `imported` is true when the stylesheet imports
 * ouro-base's own file (its rules are then the stylesheet's own, after the import), false when it holds ouro-base's
 * rules itself. `overrides` is the override list.
 */
export function compareBase(sheet: string, base: string, imported: boolean, overrides: Record<string, string>): BaseFinding[] {
  const app = readRules(sheet);
  const ouro = readRules(base);
  const findings: BaseFinding[] = [];
  const listed = new Set(Object.keys(overrides));
  const used = new Set<string>();
  const entries: [string, string | undefined, string][] = [
    ...[...ouro.decls].map(([key, value]): [string, string | undefined, string] => [key, app.decls.get(key), value]),
    ...[...ouro.keyframes].map(([key, value]): [string, string | undefined, string] => [key, app.keyframes.get(key), value]),
  ];
  for (const [key, have, want] of entries) {
    const prop = key.split(" ").at(-1)!;
    if (THEME_OWNED.has(prop) && !key.includes("@supports") && !key.includes("@media")) continue;
    if (have === undefined) {
      if (!imported && !listed.has(key)) findings.push({ kind: "missing", key, message: `${key}: the stylesheet lacks it, and ouro-base has \`${want}\`` });
      if (!imported && listed.has(key)) used.add(key);
      continue;
    }
    if (have === want) {
      if (imported) findings.push({ kind: "copy", key, message: `${key}: the stylesheet repeats ouro-base's \`${want}\` after the import; delete it, so a later release's value reaches the app` });
      continue;
    }
    if (listed.has(key)) {
      used.add(key);
      continue;
    }
    findings.push({ kind: "override", key, message: `${key}: the stylesheet sets \`${have}\` where ouro-base has \`${want}\`; delete it if it copied an older ouro-base, or add "${key}" to ${OVERRIDES} with the reason` });
  }
  for (const key of listed) if (!used.has(key)) findings.push({ kind: "stale", key, message: `${key}: ${OVERRIDES} names it, but the stylesheet no longer overrides it; take it off the list` });
  return findings;
}

/** The folder, from `start` up, that holds the pin. */
function repoRoot(start: string): string | null {
  let dir = resolve(start);
  while (!existsSync(join(dir, PIN))) {
    if (dirname(dir) === dir) return null;
    dir = dirname(dir);
  }
  return dir;
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const toPosix = (path: string) => path.split(sep).join(posix.sep);

/**
 * Checks the app in `app` (the folder that holds its components.json). `source` reads ouro-base at a tag when the
 * stylesheet holds its rules itself; by default it fetches the tag's file from GitHub.
 */
export async function checkBase(app: string, source: (tag: string) => Promise<string> = fetchSource): Promise<{ findings: BaseFinding[]; sheet: string; tag: string }> {
  const root = repoRoot(app);
  if (!root) throw new Error(`no ${PIN} in ${app} or a folder above it: Ouro Current writes it with an app's first update`);
  const pin = JSON.parse(readFileSync(join(root, PIN), "utf8")) as { tag: string; files: Record<string, string> };
  const config = JSON.parse(readFileSync(join(app, "components.json"), "utf8")) as { tailwind?: { css?: string } };
  const css = config.tailwind?.css;
  if (!css) throw new Error(`components.json in ${app} names no stylesheet (tailwind.css)`);
  const sheetPath = join(app, css);
  const sheet = readFileSync(sheetPath, "utf8");
  const overridesPath = join(root, OVERRIDES);
  const overrides = existsSync(overridesPath) ? (JSON.parse(readFileSync(overridesPath, "utf8")) as Record<string, string>) : {};
  const imported = baseImport(sheet);
  const findings: BaseFinding[] = [];
  let base: string;
  if (imported) {
    const file = join(dirname(sheetPath), imported);
    const bytes = readFileSync(file);
    const key = toPosix(relative(root, file));
    if (pin.files[key] !== sha256(bytes)) findings.push({ kind: "edited", key, message: `${key} is not ouro-base at ${pin.tag}: the pin records another hash. Put the app's changes in the stylesheet, after the import, and let Ouro Current write this file` });
    base = bytes.toString("utf8");
  } else {
    base = await source(pin.tag);
  }
  findings.push(...compareBase(sheet, base, Boolean(imported), overrides));
  return { findings, sheet: toPosix(relative(root, sheetPath)), tag: pin.tag };
}

async function fetchSource(tag: string): Promise<string> {
  const response = await fetch(`${RAW}/${encodeURIComponent(tag)}/${SOURCE}`);
  if (!response.ok) throw new Error(`could not read ouro-base at ${tag}: ${response.status} from ${RAW}`);
  return response.text();
}

/** The command: prints the findings, and fails when it finds drift. */
export async function runBaseCheck(args: readonly string[], log: (line: string) => void = console.log): Promise<number> {
  const at = args.indexOf("--source");
  const given = at >= 0 ? args[at + 1] : undefined;
  const app = args.find((arg, index) => !arg.startsWith("--") && index !== at + 1) ?? ".";
  const { findings, sheet, tag } = await checkBase(app, given ? async () => readFileSync(given, "utf8") : fetchSource);
  for (const finding of findings) log(`ouro base check: ${finding.kind}: ${finding.message}`);
  log(findings.length ? `ouro base check: ${sheet} has drifted from ouro-base at ${tag}` : `ouro base check: ${sheet} has ouro-base as ${tag} has it`);
  return findings.length ? 1 : 0;
}

/* node:coverage disable */
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await runBaseCheck(process.argv.slice(2));
}
/* node:coverage enable */
