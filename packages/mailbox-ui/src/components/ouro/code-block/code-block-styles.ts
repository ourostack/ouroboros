import { cn } from "@/lib/ouro/cn";

export { ansiClassName, parseAnsi, stripAnsi };
export type { AnsiRun, AnsiStyle };

/**
 * How a run of terminal output looks: the SGR attributes CodeBlock draws. `color` is one of the
 * 16 basic colours, 0 to 7 normal and 8 to 15 bright, or null for the text's own color.
 * @claim "`color` is one of the 16 basic colours" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::parseAnsi > maps each basic and bright color code to its color, and 39 back to none)
 * @internal
 */
interface AnsiStyle {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: number | null;
}

/** A stretch of terminal output in one style; `style` is null for plain text. @internal */
interface AnsiRun {
  text: string;
  style: AnsiStyle | null;
}

/**
 * Every escape sequence a terminal capture can hold: a CSI sequence (SGR's `ESC[…m`, and the
 * cursor and erase codes), a string sequence (OSC, such as a hyperlink, DCS, APC, PM or SOS)
 * ended by BEL or ST, and the short escapes (`ESC=`, `ESC7`, `ESC(B`). A lone ESC at the end
 * matches too.
 * @claim "Every escape sequence a terminal capture can hold" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::parseAnsi > styles only from SGR, dropping every other sequence whole)
 */
// eslint-disable-next-line no-control-regex -- terminal escape codes start with ESC, and OSC ends with BEL
const ansiEscapePattern = /\x1b(?:\[([0-?]*)([ -/]*)([@-~])|[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)|[ -/]*[0-~]|$)/g;

/** The text of terminal output without its escape codes: what a person copies. @internal */
function stripAnsi(text: string): string {
  return text.replace(ansiEscapePattern, "");
}

const plain: AnsiStyle = { bold: false, dim: false, italic: false, underline: false, strike: false, color: null };

function isPlain(style: AnsiStyle): boolean {
  return !style.bold && !style.dim && !style.italic && !style.underline && !style.strike && style.color === null;
}

/**
 * A basic color from an extended one: the 256-color table's first 16, and nothing else (a missing value is NaN).
 * @claim "A basic color from an extended one" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::parseAnsi > reads an extended color's parameters and skips them, keeping only a foreground from the table's first 16)
 */
function extendedColor(mode: number, value: number): number | null {
  return mode === 5 && value < 16 ? value : null;
}

function applySgr(style: AnsiStyle, parameters: string): AnsiStyle {
  // Parameters are split by ";"; one with ":" carries its own sub-parameters (ITU T.416), as tmux
  // writes a curly underline (4:3) or a true color (38:2::r:g:b).
  // An empty parameter is 0, as Number("") is, so ESC[m resets.
  const parts = parameters.split(";");
  let next = { ...style };
  for (let index = 0; index < parts.length; index += 1) {
    const [head, ...subs] = parts[index]!.split(":").map(Number);
    const code = head!;
    if (subs.length > 0) {
      if (code === 4) next.underline = subs[0] !== 0;
      else if (code === 38) next.color = extendedColor(subs[0]!, Number(subs[1]));
      continue;
    }
    if (code === 0) next = { ...plain };
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 9) next.strike = true;
    else if (code === 22) next = { ...next, bold: false, dim: false };
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 29) next.strike = false;
    else if (code >= 30 && code <= 37) next.color = code - 30;
    else if (code >= 90 && code <= 97) next.color = code - 90 + 8;
    else if (code === 39) next.color = null;
    else if (code === 38 || code === 48 || code === 58) {
      // An extended foreground, background or underline color: 5;n or 2;r;g;b. A foreground from the
      // 256-color table's first 16 is a basic color; any other, and every background and underline
      // color, keeps the theme's own, so the text keeps its contrast on the block.
      const mode = Number(parts[index + 1]);
      if (code === 38) next.color = extendedColor(mode, Number(parts[index + 2]));
      index += mode === 5 ? 2 : mode === 2 ? 4 : 1;
    }
  }
  return next;
}

/**
 * Splits terminal output into runs of one style, reading its SGR codes (`ESC[…m`) and dropping
 * every other escape sequence. Backgrounds and colors outside the basic 16 are dropped, so the
 * text keeps the block's surface and its contrast.
 * @claim "dropping every other escape sequence" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::parseAnsi > styles only from SGR, dropping every other sequence whole)
 * @claim "Backgrounds and colors outside the basic 16 are dropped" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::parseAnsi > ignores the codes it does not draw: blink, backgrounds and the rest)
 * @claim "Backgrounds and colors outside the basic 16 are dropped" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::parseAnsi > reads an extended color's parameters and skips them, keeping only a foreground from the table's first 16)
 * @internal
 */
function parseAnsi(text: string): AnsiRun[] {
  const runs: AnsiRun[] = [];
  let style = plain;
  let last = 0;
  const push = (chunk: string) => {
    if (chunk === "") return;
    const runStyle = isPlain(style) ? null : style;
    const previous = runs[runs.length - 1];
    if (previous && JSON.stringify(previous.style) === JSON.stringify(runStyle)) previous.text += chunk;
    else runs.push({ text: chunk, style: runStyle });
  };
  for (const match of text.matchAll(ansiEscapePattern)) {
    push(text.slice(last, match.index));
    last = match.index + match[0].length;
    // An SGR code is a CSI sequence ending in m, with no intermediate bytes.
    if (match[3] === "m" && match[2] === "") style = applySgr(style, match[1]!);
  }
  push(text.slice(last));
  return runs;
}

// Each color is a hue at oklch(0.58 0.18 h) mixed 55% into the theme's foreground, and a bright one
// the same hue at 1.5 times the chroma, so it darkens on a light theme and lightens on a dark one,
// and keeps 4.5:1 on the block's muted surface, in third-party themes too (CodeBlock's contrast
// test and the theme stories). Black is the muted text color and white the
// foreground, so neither disappears on either theme.
const colors = [
  "[--ouro-ansi:color-mix(in_oklab,var(--muted-foreground)_80%,var(--foreground))]",
  "[--ouro-ansi:color-mix(in_oklab,oklch(0.58_0.18_25)_55%,var(--foreground))]",
  "[--ouro-ansi:color-mix(in_oklab,oklch(0.58_0.18_145)_55%,var(--foreground))]",
  "[--ouro-ansi:color-mix(in_oklab,oklch(0.58_0.18_90)_55%,var(--foreground))]",
  "[--ouro-ansi:color-mix(in_oklab,oklch(0.58_0.18_260)_55%,var(--foreground))]",
  "[--ouro-ansi:color-mix(in_oklab,oklch(0.58_0.18_330)_55%,var(--foreground))]",
  "[--ouro-ansi:color-mix(in_oklab,oklch(0.58_0.18_200)_55%,var(--foreground))]",
  "[--ouro-ansi:var(--foreground)]",
  "[--ouro-ansi:color-mix(in_oklab,var(--muted-foreground)_80%,var(--foreground))]",
  "[--ouro-ansi:color-mix(in_oklab,oklch(0.58_0.27_25)_55%,var(--foreground))]",
  "[--ouro-ansi:color-mix(in_oklab,oklch(0.58_0.27_145)_55%,var(--foreground))]",
  "[--ouro-ansi:color-mix(in_oklab,oklch(0.58_0.27_90)_55%,var(--foreground))]",
  "[--ouro-ansi:color-mix(in_oklab,oklch(0.58_0.27_260)_55%,var(--foreground))]",
  "[--ouro-ansi:color-mix(in_oklab,oklch(0.58_0.27_330)_55%,var(--foreground))]",
  "[--ouro-ansi:color-mix(in_oklab,oklch(0.58_0.27_200)_55%,var(--foreground))]",
  "[--ouro-ansi:var(--foreground)]",
] as const;

/**
 * The classes for a run's style. Dim text is the muted text color mixed 20% toward the
 * foreground, as muted text on a muted surface is everywhere in Ouro, and a dim color is that
 * color halfway to it.
 * @claim "Dim text is the muted text color mixed 20% toward the" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::CodeBlock terminal output > keeps every color and dim at 4.5:1 on the block in light and dark, with dim text muted beside the rest)
 * @claim "Dim text is the muted text color mixed 20% toward the" registry/ouro/components/ouro/code-block/code-block-styles.ts verify:fileLine(registry/ouro/components/ouro/code-block/code-block-styles.ts, /: style\.dim && "text-\[color-mix\(in_oklab,var\(--muted-foreground\)_80%,var\(--foreground\)\)\]"/)
 * @internal
 */
function ansiClassName(style: AnsiStyle): string {
  // Stryker disable next-line ConditionalExpression: colors[null] is undefined too; the check is for the type.
  const color = style.color === null ? undefined : colors[style.color];
  return cn(
    color,
    color
      ? style.dim
        ? "text-[color-mix(in_oklab,var(--ouro-ansi)_50%,color-mix(in_oklab,var(--muted-foreground)_80%,var(--foreground)))]"
        : "text-(--ouro-ansi)"
      : style.dim && "text-[color-mix(in_oklab,var(--muted-foreground)_80%,var(--foreground))]",
    style.bold && "font-bold",
    style.italic && "italic",
    style.underline && style.strike ? "[text-decoration-line:underline_line-through]" : style.underline ? "underline" : style.strike && "line-through",
  );
}
