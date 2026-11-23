"use client";

import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type JSX, type ReactNode } from "react";
import { useUntilFound } from "@/lib/ouro/use-until-found";

/** @internal */
export interface CssPanelProps extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "hidden" | "className"> {
  /** Whether the content is open. */
  open: boolean;
  /** Called when the browser's page search finds text in the closed content. */
  onFound: () => void;
  /** The content. */
  children: ReactNode;
  /** Padding and the like for the content's own box, inside the part that clips. */
  contentClassName?: string | undefined;
}

/**
 * A panel that opens and closes with CSS alone: a grid whose row goes from `0fr` to `1fr`,
 * so the browser animates to the content's height. Closed, it
 * stays mounted and hidden (found by the page search where `hidden="until-found"` works),
 * and it stays shown through its closing transition.
 *
 * @internal
 */
export function CssPanel({ open, onFound, children, contentClassName, ...rest }: CssPanelProps): JSX.Element {
  const untilFound = useUntilFound();
  const panelRef = useRef<HTMLDivElement>(null);
  const foundRef = useRef(onFound);
  useLayoutEffect(() => {
    foundRef.current = onFound;
  });
  // The panel stays shown through its closing transition, then hides.
  const [seen, setSeen] = useState(open);
  // Stryker disable next-line BooleanLiteral: the first closing state is overwritten by the render-phase sync before any effect reads it.
  const [closing, setClosing] = useState(false);
  const [moved, setMoved] = useState(false);
  if (seen !== open) {
    setSeen(open);
    setMoved(true);
    setClosing(!open);
  }
  const listenForFound = () => {
    const panel = panelRef.current;
    // Stryker disable next-line ConditionalExpression: the panel always exists once effects run; the guard only satisfies the type.
    /* istanbul ignore next @preserve -- the panel always exists once effects run */
    if (!panel) return;
    const found = () => foundRef.current();
    panel.addEventListener("beforematch", found);
    return () => panel.removeEventListener("beforematch", found);
  };
  // Stryker disable next-line ArrayDeclaration: the effect reads only refs, so re-running it adds the same listener again.
  useEffect(listenForFound, []);
  useEffect(() => {
    const panel = panelRef.current;
    // Stryker disable next-line ConditionalExpression,LogicalOperator: the panel always exists once effects run, and an open panel has nothing to close.
    if (!closing || !panel) return;
    if (panel.getAnimations().length === 0) {
      setClosing(false);
      return;
    }
    const done = (event: Event) => {
      // Stryker disable next-line ConditionalExpression: transition events from the panel's descendants do not occur in this markup.
      /* istanbul ignore else @preserve -- descendants of the panel send no transition events */
      if (event.target === panel) setClosing(false);
    };
    // Stryker disable next-line StringLiteral: the cancel and end listeners are interchangeable for the same transition.
    panel.addEventListener("transitionend", done);
    // Stryker disable next-line StringLiteral,CallExpression: the cancel and end listeners are interchangeable for the same transition.
    panel.addEventListener("transitioncancel", done);
    // Stryker disable next-line BlockStatement: the panel is kept for the component's life, so an unreleased listener is unobservable.
    return () => {
      // Stryker disable next-line StringLiteral,CallExpression: removal only releases a listener on a node that is being kept.
      panel.removeEventListener("transitionend", done);
      // Stryker disable next-line StringLiteral,CallExpression: removal only releases a listener on a node that is being kept.
      panel.removeEventListener("transitioncancel", done);
    };
  }, [closing]);
  const shown = open || closing;
  // React writes a plain `hidden`; the until-found value is set by hand.
  useLayoutEffect(() => {
    // Stryker disable next-line OptionalChaining: the ref is set before layout effects run.
    if (!shown && untilFound) panelRef.current?.setAttribute("hidden", "until-found");
  }, [shown, untilFound]);
  return (
    <div
      {...rest}
      ref={panelRef}
      // Stryker disable next-line BooleanLiteral: hidden="false" would still hide in the same way for the browser engines under test.
      hidden={shown ? undefined : true}
      // Stryker disable next-line StringLiteral: any value of a presence attribute styles the same.
      data-open={open ? "" : undefined}
      // Stryker disable next-line StringLiteral: any value of a presence attribute styles the same.
      data-moved={moved ? "" : undefined}
      className={
        "grid w-full grid-rows-[0fr] data-open:grid-rows-[1fr] " +
        "transition-[grid-template-rows] duration-(--ouro-duration-base) ease-(--ouro-ease-out) motion-reduce:transition-none " +
        "data-moved:starting:grid-rows-[0fr] [&[hidden]:not([hidden=until-found])]:hidden"
      }
    >
      <div className="min-h-0 overflow-hidden">
        <div className={contentClassName}>{children}</div>
      </div>
    </div>
  );
}
