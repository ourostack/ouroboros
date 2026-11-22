"use client";

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type JSX, type MouseEvent, type Ref, type SVGProps } from "react";
import { announce } from "@/lib/ouro/announce";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import { Button } from "@/components/ouro/button/button";

/** The props CopyButton adds to the `<button>` attributes it passes through. */
export interface CopyButtonOwnProps {
  /** The text the button puts on the clipboard. */
  value: string;
  /** The button's label, and its name for screen readers when `hideLabel` is set. @default "Copy" */
  label?: string | undefined;
  /** What the button says, and screen readers hear, once the text is on the clipboard. @default "Copied" */
  copiedLabel?: string | undefined;
  /**
   * What the button says for two seconds when the browser refused to copy: short, so the button keeps its width. @default "Browser blocked copying"
   * @claim "What the button says for two seconds" registry/ouro/components/ouro/copy-button/copy-button.test.tsx verify:testExists(registry/ouro/components/ouro/copy-button/copy-button.test.tsx::CopyButton > by default shows Browser blocked copying, with how to copy by hand as its tooltip, and announces the whole sentence once) verify:testExists(registry/ouro/components/ouro/copy-button/copy-button.test.tsx::CopyButton > keeps a 390px-wide page from scrolling sideways when it says the browser blocked copying, at every size)
   */
  failedLabel?: string | undefined;
  /**
   * What screen readers hear, and the button's tooltip says while it shows `failedLabel`, when the
   * browser refused to copy: what happened and what to do instead.
   * @default "The browser blocked copying. Select the text and copy it by hand.", or `failedLabel` when only that is given
   */
  failedMessage?: string | undefined;
  /** Shows only the icon; the label stays the button's name for screen readers. For a corner of a code block or a field. */
  hideLabel?: boolean | undefined;
  /** Visual weight, as Button's. @default "outline" */
  variant?: "solid" | "soft" | "outline" | "plain" | (string & { 'Use "solid", "soft", "outline" or "plain"; ghost is "plain"': never }) | undefined;
  /** Control size, as Button's. @default "sm" */
  size?: "sm" | "md" | "lg" | (string & { 'Use "sm", "md" or "lg"': never }) | undefined;
  /** Called with the text once it is on the clipboard. */
  onCopy?: ((value: string) => void) | undefined;
  /** Layout only: margins, grid placement (`ms-auto`). Appearance classes warn in development. */
  className?: string | undefined;
  ref?: Ref<HTMLButtonElement> | undefined;

  /** Not a prop. The text to copy is `value`: `<CopyButton value={token} />`. */
  text?: { 'Use <CopyButton value={text} />': never };
  /** Not a prop. The text to copy is `value`: `<CopyButton value={token} />`. */
  content?: { 'Use <CopyButton value={text} />': never };
  /** Not a prop. The label is `label`: `<CopyButton value={url} label="Copy link" />`. */
  children?: { 'Use <CopyButton value={text} label="Copy link" />': never };
  /**
   * Not a prop. The confirmation is `copiedLabel`, and it lasts two seconds.
   *
   * @claim "The confirmation is `copiedLabel`, and it" registry/ouro/components/ouro/copy-button/copy-button.test.tsx verify:testExists(registry/ouro/components/ouro/copy-button/copy-button.test.tsx::CopyButton > puts the value on the clipboard, says Copied once, calls onCopy and reads Copy again after two seconds)
   */
  timeout?: { 'Use copiedLabel="Copied"; it shows for two seconds': never };
  /** Not a prop. CopyButton copies on click itself; to react to a copy, pass `onCopy`. */
  onClick?: { 'Use onCopy={(value) => ...}; CopyButton copies on click itself': never };
}

/** Props for {@link CopyButton}: its own props and the `<button>` attributes it passes through. */
export type CopyButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof CopyButtonOwnProps | "type" | "color"> & CopyButtonOwnProps;

type Status = "idle" | "copied" | "failed";

const variants = ["solid", "soft", "outline", "plain"] as const;
const sizes = ["sm", "md", "lg"] as const;
/** How long the button says it copied before it reads its label again. */
const CONFIRM_MS = 2000;

function CopyIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function CheckIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function FailedIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

/** Copies through a hidden text area, for pages the Clipboard API is not open to (plain http, an old browser). */
function copyWithSelection(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  Object.assign(area.style, { position: "fixed", top: "0", left: "0", opacity: "0", pointerEvents: "none" });
  const focused = document.activeElement as HTMLElement;
  document.body.append(area);
  area.select();
  let copied: boolean;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  focused.focus({ preventScroll: true });
  return copied;
}

async function writeClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // A browser that refuses (no permission, the page not focused) may still copy a selection.
    }
  }
  return copyWithSelection(text);
}

/**
 * A button that puts a piece of text on the clipboard: an API key, a link, a command. On a
 * click it copies `value`, then for two seconds shows a check and says "Copied", and screen
 * readers hear the same, politely, once. When the browser refuses, it shows a cross and
 * "Browser blocked copying" for two seconds, with the whole of `failedMessage` ("The browser
 * blocked copying. Select the text and copy it by hand.") as its tooltip, and screen readers
 * hear that whole sentence once. It uses the Clipboard API, and a text selection where that is
 * not available.
 *
 * Use `CodeBlock` instead for code or a command shown with its own copy button.
 *
 * @group Actions
 * @see https://ui.ouroboros.bot/docs/copy-button
 *
 * @example
 * <CopyButton value={apiKey} label="Copy key" />
 * <CopyButton value={url} label="Copy link" hideLabel variant="plain" />
 * @claim "On a click it copies `value`" registry/ouro/components/ouro/copy-button/copy-button.test.tsx verify:testExists(registry/ouro/components/ouro/copy-button/copy-button.test.tsx::CopyButton > puts the value on the clipboard, says Copied once, calls onCopy and reads Copy again after two seconds)
 * @claim "On a click it copies `value`" registry/ouro/components/ouro/copy-button/copy-button.test.tsx verify:fileLine(registry/ouro/components/ouro/copy-button/copy-button.test.tsx, /says\sthat\sthe\sbrowser\sblocked\scopying,\sonce,\swhen\sthe\sbrowser\srefuses/)
 * @claim "When the browser refuses, it shows" registry/ouro/components/ouro/copy-button/copy-button.test.tsx verify:testExists(registry/ouro/components/ouro/copy-button/copy-button.test.tsx::CopyButton > by default shows Browser blocked copying, with how to copy by hand as its tooltip, and announces the whole sentence once)
 */
export function CopyButton(props: CopyButtonProps): JSX.Element {
  const {
    value,
    label = "Copy",
    copiedLabel = "Copied",
    failedLabel = "Browser blocked copying",
    failedMessage = props.failedLabel ?? "The browser blocked copying. Select the text and copy it by hand.",
    hideLabel,
    variant: variantProp = "outline",
    size: sizeProp = "sm",
    onCopy,
    className,
    ref,
    disabled,
    // Guard props (hint types), dropped here so they never reach the DOM.
    text,
    content,
    children,
    timeout,
    onClick,
    ...rest
  } = props;
  const variant = (variants as readonly string[]).includes(variantProp) ? (variantProp as (typeof variants)[number]) : "outline";
  const size = (sizes as readonly string[]).includes(sizeProp) ? (sizeProp as (typeof sizes)[number]) : "sm";
  useAppearanceClassNameCheck(
    "CopyButton",
    className,
    process.env.NODE_ENV !== "production"
      ? (token: string) => `remove "${token}"; use variant="plain" or size="md"`
      : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "CopyButton",
    process.env.NODE_ENV !== "production"
      ? () => [
          variant !== variantProp && [`variant="${String(variantProp)}" is not a variant; use "solid", "soft", "outline" or "plain"`, '<CopyButton value={text} variant="plain" />'],
          size !== sizeProp && [`size="${String(sizeProp)}" is not a size; use "sm", "md" or "lg"`, '<CopyButton value={text} size="sm" />'],
          text !== undefined && ["text is not a prop", "<CopyButton value={text} />"],
          content !== undefined && ["content is not a prop", "<CopyButton value={text} />"],
          children !== undefined && ["CopyButton takes no children; its label is label", `<CopyButton value={text} label="${typeof children === "string" ? children : "Copy"}" />`],
          timeout !== undefined && ["timeout is not a prop; the confirmation shows for two seconds", '<CopyButton value={text} copiedLabel="Copied" />'],
          onClick !== undefined && ["onClick is not a prop; CopyButton copies on click itself", "<CopyButton value={text} onCopy={(value) => {}} />"],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  const [status, setStatus] = useState<Status>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const copy = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const copied = await writeClipboard(value);
    if (copied) onCopy?.(value);
    // Gone before the clipboard answered: nothing is left to show or say it.
    if (!mounted.current) return;
    clearTimeout(timer.current);
    setStatus(copied ? "copied" : "failed");
    announce(copied ? copiedLabel : failedMessage);
    timer.current = setTimeout(() => setStatus("idle"), CONFIRM_MS);
  };

  const shown = status === "copied" ? copiedLabel : status === "failed" ? failedLabel : label;
  const Icon = status === "copied" ? CheckIcon : status === "failed" ? FailedIcon : CopyIcon;
  return (
    <span data-ouro="copy-button" data-status={status} className={cn("inline-flex", className)}>
      <Button
        data-ouro-control="copy-button"
        data-ouro-part="trigger"
        {...rest}
        ref={ref}
        disabled={disabled}
        variant={variant}
        size={size}
        tone="secondary"
        onClick={copy}
        {...(status === "failed" ? { title: failedMessage } : {})}
        {...(hideLabel ? { "aria-label": shown, className: "w-(--ouro-button-h) px-0" } : { startIcon: Icon })}
      >
        {hideLabel ? <Icon className="size-[1.25em] shrink-0" /> : shown}
      </Button>
    </span>
  );
}
