"use client";

import { useId, type JSX } from "react";

/** What a control that takes `disabledReason` reads from it. */
export interface DisabledReasonWiring {
  /** Whether the control is off with a reason: `disabledReason` is a non-empty string. */
  off: boolean;
  /** Whether the control is wrapped in a Tooltip. True whenever the prop is passed, even as `undefined`, so a control keeps its place (and focus) as it turns off and on. */
  wrapped: boolean;
  /** The text the Tooltip shows: the reason, or nothing while the control is on. */
  reason: string | undefined;
  /** `aria-describedby` for the control: its own value, then the reason's element when off. */
  describedBy: string | undefined;
  /** The reason as visually hidden text for `aria-describedby` to point at, to render inside the control. */
  note: JSX.Element | null;
}

/**
 * The wiring behind a control's `disabledReason`: the id, the `aria-describedby` merge and the hidden text.
 * A component calls it with the prop and its own `aria-describedby`, and renders `note` inside the control.
 *
 * @internal
 * @example
 * const reason = useDisabledReason(props, props["aria-describedby"]);
 */
export function useDisabledReason(props: { disabledReason?: string | undefined }, describedBy?: string): DisabledReasonWiring {
  const id = useId();
  const wrapped = "disabledReason" in props;
  const reason = props.disabledReason || undefined;
  const off = reason !== undefined;
  return {
    off,
    wrapped,
    reason,
    describedBy: off ? [describedBy, id].filter(Boolean).join(" ") : describedBy,
    note: off ? (
      <span hidden id={id}>
        {reason}
      </span>
    ) : null,
  };
}
