"use client";

import { Fragment, useCallback, useRef, type HTMLAttributes, type JSX, type ReactNode, type Ref, type RefCallback } from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { useMergedRef } from "@/lib/ouro/refs";
import { scrollFadeClass, useScrollFade } from "@/lib/ouro/scroll-fade";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import { CopyButton } from "@/components/ouro/copy-button/copy-button";
import { Emoji, type EmojiCatalogue } from "@/components/ouro/emoji/emoji";
import { splitEmojiText } from "@/components/ouro/emoji/emoji-styles";
import { ansiClassName, parseAnsi, stripAnsi } from "@/components/ouro/code-block/code-block-styles";

/** The props CodeBlock adds to the `<figure>` attributes it passes through. */
export interface CodeBlockOwnProps {
  /**
   * The code, as plain text. It shows exactly as given, whitespace and all, and is what the copy button copies.
   * Terminal output with escape codes takes `language="ansi"`.
   *
   * @claim "It shows exactly as given, whitespace" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::CodeBlock > copies the code exactly with its copy button)
   * @claim "It shows exactly as given, whitespace" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::CodeBlock > shows the code as given on the muted surface in the monospace font, under a caption naming its language)
   */
  code: string;
  /**
   * The language, shown in the block's caption when there is no `title` and set as
   * `data-language` on the block for a highlighter of your own: `language="bash"`.
   *
   * `language="ansi"` reads `code` as terminal output, such as `tmux capture-pane -e` gives:
   * its escape codes style the text instead of showing. Bold, dim, italic, underline, strikethrough and
   * the 16 basic and bright foreground colors show, in colors mixed from the theme so they keep
   * their contrast in light and dark; dim text is the theme's muted text color. Every other escape
   * code is dropped, and copying gives the text without them.
   * @claim "its escape codes style the text instead of showing" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::CodeBlock terminal output > styles bold, dim, italic, underline, strikethrough and the basic and bright colors from SGR codes, and drops the codes)
   * @claim "so they keep their contrast in light and dark" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::CodeBlock terminal output > keeps every color and dim at 4.5:1 on the block in light and dark, with dim text muted beside the rest)
   * @claim "Every other escape code is dropped, and copying" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::CodeBlock terminal output > copies the output without its escape codes)
   * @claim "The language, shown in the block's" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::CodeBlock > captions with the title rather than the language)
   * @claim "The language, shown in the block's" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:fileLine(registry/ouro/components/ouro/code-block/code-block.test.tsx, /getAttribute\("data-language"\)\)\.toBe\("bash"\)/)
   */
  language?: string | undefined;
  /** A caption above the code, such as its file name: `title="vite.config.ts"`. */
  title?: ReactNode;
  /**
   * The copy button in the bar above the code. Turn it off for code nobody should paste, such as
   * output. @default true
   */
  copy?: boolean | undefined;
  /** The copy button's name for screen readers. @default "Copy code" */
  copyLabel?: string | undefined;
  /**
   * Wraps long lines instead of scrolling them sideways. Scrolling keeps code as written,
   * so leave it off for code and turn it on for prose-like text such as a long command.
   */
  wrap?: boolean | undefined;
  /**
   * An image emoji catalogue: emoji characters in the code that it lists show as its pictures,
   * 1em square, over the characters themselves, which stay in place unseen. The lines keep
   * their length and wrapping, and copying or selecting gives the code's own characters.
   * `:shortcode:` text stays text, since in code it means something else.
   *
   * @claim "1em square, over the characters themselves" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::CodeBlock emoji > draws the catalogue's emoji as 1em pictures over the code's own characters, without moving a line)
   * @claim "copying or selecting gives the code's own characters" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::CodeBlock emoji > copies and selects the code's own characters, and leaves shortcode text as it is)
   */
  catalogue?: EmojiCatalogue | undefined;
  /** Layout only: margins, width, a maximum height that scrolls (`max-h-80`). Appearance classes warn in development. */
  className?: string | undefined;
  ref?: Ref<HTMLElement> | undefined;

  /** Not a prop. The code is `code`, a string: `<CodeBlock code={source} />`. */
  children?: { 'Use <CodeBlock code={source} />': never };
  /** Not a prop. Ouro UI uses `language`: `<CodeBlock code={source} language="tsx" />`. */
  lang?: { 'Use <CodeBlock language="tsx" />': never };
  /** Not a prop. The caption is `title`: `<CodeBlock code={source} title="app.tsx" />`. */
  filename?: { 'Use <CodeBlock title="app.tsx" />': never };
  /** Not a prop. The copy button is on by default; `copy={false}` turns it off. */
  showCopyButton?: { 'Use copy={false} to hide the copy button; it shows by default': never };
}

/** Props for {@link CodeBlock}: its own props and the `<figure>` attributes it passes through. */
export type CodeBlockProps = Omit<HTMLAttributes<HTMLElement>, keyof CodeBlockOwnProps> & CodeBlockOwnProps;

/**
 * Makes the code a tab stop while it overflows either way, so a keyboard can scroll it (WCAG 2.1.1).
 *
 * @claim "Makes the code a tab stop" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::CodeBlock > scrolls a long line sideways and becomes a tab stop only while it overflows)
 * @claim "Makes the code a tab stop" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::CodeBlock > scrolls tall code within a maximum height the app sets, as a tab stop)
 * @claim "Makes the code a tab stop" https://www.w3.org/TR/WCAG22/#keyboard verify:urlOk(https://www.w3.org/TR/WCAG22/#keyboard)
 */
function useScrollableCode(): RefCallback<HTMLPreElement> {
  return useCallback((element: HTMLPreElement | null) => {
    // React 19 calls a ref that returns a cleanup with the element only; the cleanup replaces the call with null.
    /* istanbul ignore if @preserve -- never called with null */
    if (!element) return;
    const update = () => {
      const overflows = element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight;
      if (overflows) element.setAttribute("tabindex", "0");
      // Removing the focused block's tab stop would drop focus to <body>; it goes once focus leaves.
      else if (element !== document.activeElement) element.removeAttribute("tabindex");
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    observer.observe(element.firstElementChild!);
    element.addEventListener("blur", update);
    return () => {
      observer.disconnect();
      element.removeEventListener("blur", update);
    };
  }, []);
}

/**
 * The code with each emoji character the catalogue lists drawn as its picture: the characters
 * stay in the text, unseen, so the line keeps its length and a selection copies them, and the
 * picture sits over them, 1em square.
 *
 * @claim "so the line keeps its length" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::CodeBlock emoji > draws the catalogue's emoji as 1em pictures over the code's own characters, without moving a line)
 * @claim "a selection copies them" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::CodeBlock emoji > copies and selects the code's own characters, and leaves shortcode text as it is)
 */
function CodeWithEmoji({ code, catalogue }: { code: string; catalogue: EmojiCatalogue }): ReactNode {
  return splitEmojiText(code, catalogue, false).map((part, index) =>
    typeof part === "string" ? (
      part
    ) : (
      <span key={index} data-ouro-code-emoji="" className="relative">
        <span className="text-transparent [forced-color-adjust:none]">{part.source}</span>
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Emoji item={part.item} skinTone={part.tone} play={false} alt="" className="size-[1em] align-baseline" />
        </span>
      </span>
    ),
  );
}

/**
 * Terminal output drawn from its SGR codes: each run of one style is a span with that style's
 * classes, and its text goes through the emoji catalogue when there is one.
 * @claim "each run of one style is a span" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::CodeBlock terminal output > styles bold, dim, italic, underline, strikethrough and the basic and bright colors from SGR codes, and drops the codes)
 * @claim "its text goes through the emoji catalogue" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::CodeBlock terminal output > draws a catalogue's emoji inside styled output)
 */
function AnsiCode({ code, catalogue }: { code: string; catalogue: EmojiCatalogue | undefined }): ReactNode {
  return parseAnsi(code).map((run, index) => {
    const text = catalogue ? <CodeWithEmoji code={run.text} catalogue={catalogue} /> : run.text;
    return run.style ? (
      <span key={index} data-ouro-ansi="" className={ansiClassName(run.style)}>
        {text}
      </span>
    ) : (
      <Fragment key={index}>{text}</Fragment>
    );
  });
}

/**
 * Code or a command on a muted surface in the theme's monospace font, with a caption
 * and a button that copies it. The code shows exactly as given and scrolls sideways
 * rather than wrapping (unless `wrap`), fading out at the side where a long line goes on, and
 * the block becomes a tab stop while it overflows, so a keyboard can scroll it. Copying says
 * "Copied" to screen readers.
 *
 * It does not color code; to highlight it, set colors on the `data-language` block
 * from a highlighter of your own, or pass highlighted code to your own `<pre>`. Terminal
 * output is the exception: with `language="ansi"`, its escape codes color and dim it, on the
 * server too. With `catalogue`, the emoji characters in the code show as an image catalogue's pictures.
 *
 * Use `Kbd` instead for a key or shortcut in a sentence, `<code>` for a short name in
 * running text, and `CopyButton` for one value without a block around it.
 *
 * @group Display
 * @see https://ui.ouroboros.bot/docs/code-block
 *
 * @claim "on the server too" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::CodeBlock terminal output > renders the styled output to a string, with no escape codes in it)
 * @claim "fading out at the side where a long line goes on" registry/ouro/components/ouro/code-block/code-block.test.tsx verify:testExists(registry/ouro/components/ouro/code-block/code-block.test.tsx::CodeBlock > fades out at the side where a long line goes on, with its focus ring outside the fade)
 * @example
 * <CodeBlock language="bash" code="npx shadcn@latest add button" />
 * <CodeBlock title="vite.config.ts" code={config} className="max-h-80" />
 * <CodeBlock language="ansi" title="What I saw" code={capture} copy={false} wrap />
 */
export function CodeBlock(props: CodeBlockProps): JSX.Element {
  const {
    code,
    language,
    title,
    copy = true,
    copyLabel = "Copy code",
    wrap,
    catalogue,
    className,
    ref,
    // Guard props (hint types), dropped here so they never reach the DOM.
    children,
    lang,
    filename,
    showCopyButton,
    ...rest
  } = props;
  useAppearanceClassNameCheck(
    "CodeBlock",
    className,
    process.env.NODE_ENV !== "production"
      ? (token: string) => `remove "${token}"; CodeBlock sets its own look from the theme`
      : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "CodeBlock",
    process.env.NODE_ENV !== "production"
      ? () => [
          children !== undefined && ["CodeBlock takes its code as code, a string", "<CodeBlock code={source} />"],
          lang !== undefined && ["lang is not a prop", `<CodeBlock language="${typeof lang === "string" ? lang : "tsx"}" />`],
          filename !== undefined && ["filename is not a prop", `<CodeBlock title="${typeof filename === "string" ? filename : "app.tsx"}" />`],
          showCopyButton !== undefined && ["showCopyButton is not a prop; the copy button shows by default", "<CodeBlock code={source} copy={false} />"],
          language !== "ansi" && code.includes("\x1b[") && ["the code holds terminal escape codes, which show as raw characters", "<CodeBlock language=\"ansi\" code={output} />"],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  const fadeRef = useRef<HTMLPreElement>(null);
  useScrollFade(fadeRef);
  const scrollable = useMergedRef(useScrollableCode(), fadeRef);
  const ansi = language === "ansi";
  const caption = title ?? language;
  const bar = caption != null || copy;
  // The focus ring is the figure's outline, not an element over the code: axe reads an element over
  // a line of text as hiding its background, so it could not judge the text's contrast and measured each
  // line from a screenshot. The code's mask would also hide an outline on the code itself.
  // The caption and the copy button share the bar above the code as siblings in the grid: a
  // <figcaption> names the figure, so the button stays out of it.
  return (
    <figure
      {...rest}
      ref={ref}
      data-ouro="code-block"
      data-language={language}
      className={cn(
        // The figure doesn't clip what is in it (#2349): a squircle clip repaints the whole block as the code scrolls. The code
        // area, the one part that runs edge to edge, rounds its own corners, inside a plain rectangular clip, which is cheap and
        // which axe reads as the edge of the code's text, so it can measure that text's contrast without a screenshot.
        "[@layer_ouro-reset]:m-0 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] rounded-ouro-lg border border-solid border-border bg-muted text-foreground outline-ring outline-offset-2 has-[[data-ouro-part=code]:focus-visible]:outline-2 has-[[data-ouro-part=code]:focus-visible]:outline-solid",
        bar ? "grid-rows-[minmax(calc(var(--spacing)*11),auto)_minmax(0,1fr)]" : "grid-rows-[minmax(0,1fr)]",
        className,
      )}
    >
      {caption != null ? (
        <figcaption
          data-slot="caption"
          className="col-start-1 row-start-1 flex min-w-0 items-center ps-4 pe-2 text-xs leading-5 font-medium text-[color-mix(in_oklab,var(--muted-foreground)_80%,var(--foreground))]"
        >
          <span className="min-w-0 truncate">{caption}</span>
        </figcaption>
      ) : null}
      {copy ? (
        <CopyButton
          data-ouro-control="code-block"
          data-ouro-part="copy"
          value={ansi ? stripAnsi(code) : code}
          label={copyLabel}
          hideLabel
          variant="plain"
          size="sm"
          className="col-start-2 row-start-1 self-center me-1.5"
        />
      ) : null}
      {bar ? (
        // The code's fade would fade a hairline drawn on the code, so it sits beside the code, under its transparent top border (#530).
        <span aria-hidden="true" data-slot="rule" className="pointer-events-none col-span-2 col-start-1 row-start-2 h-px self-start border-0 border-t border-solid border-border" />
      ) : null}
      <div data-slot="code-clip" className={cn("col-span-2 col-start-1 grid min-h-0 min-w-0 overflow-hidden", bar ? "row-start-2" : "row-start-1")}>
        <pre
          ref={scrollable}
          data-ouro-control="code-block"
          data-ouro-part="code"
          className={cn(
            "m-0 min-h-0 min-w-0 overflow-auto p-4 font-mono text-sm leading-6 outline-none",
            scrollFadeClass,
            bar ? "rounded-b-[calc(var(--radius-ouro-lg)-1px)] border-0 border-t border-solid border-transparent" : "rounded-[calc(var(--radius-ouro-lg)-1px)]",
            wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
          )}
        >
          <code className={cn("[font-family:inherit]", wrap ? "block" : "block w-max min-w-full")}>{ansi ? <AnsiCode code={code} catalogue={catalogue} /> : catalogue ? <CodeWithEmoji code={code} catalogue={catalogue} /> : code}</code>
        </pre>
      </div>
    </figure>
  );
}
