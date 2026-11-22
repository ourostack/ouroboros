"use client";

import type { HTMLAttributes, JSX, ReactNode, Ref } from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import { Heading } from "@/components/ouro/text/heading";
import { Text } from "@/components/ouro/text/text";

/** The props Empty adds to the HTML attributes it passes through. */
export interface EmptyOwnProps {
  /**
   * What is empty, as a short heading: "No recipes yet". Required, because it is what a screen reader finds.
   *
   * @claim "What is empty, as a short" registry/ouro/components/ouro/empty/empty.test.tsx verify:testExists(registry/ouro/components/ouro/empty/empty.test.tsx::Empty > renders the title as an <h3>, the description, the icon and the action)
   */
  title: string;
  /** What the person can do about it, in a sentence: "Start by creating your first recipe." */
  description?: ReactNode;
  /** A decorative icon above the title, in a muted circle. Hidden from screen readers. */
  icon?: ReactNode;
  /** The way out, usually one `Button`: `action={<Button href="/recipes/new">Create recipe</Button>}`. */
  action?: ReactNode;
  /** Anything else under the description, such as a search field. */
  children?: ReactNode;
  /**
   * The title's heading level. Pick the level below the section the Empty sits in.
   * @default 3
   */
  headingLevel?: 2 | 3 | 4 | 5 | 6 | (number & { "Use 2 to 6, one below the section's heading": never }) | undefined;
  /**
   * `outline` draws a dashed border around the empty area; `plain` has none, for an Empty
   * inside a `Card` or a list that already has an edge.
   * @default "outline"
   * @claim "`outline` draws a dashed border around" registry/ouro/components/ouro/empty/empty.test.tsx verify:testExists(registry/ouro/components/ouro/empty/empty.test.tsx::Empty > centers its content and draws a dashed outline by default)
   * @claim "`outline` draws a dashed border around" registry/ouro/components/ouro/empty/empty.test.tsx verify:testExists(registry/ouro/components/ouro/empty/empty.test.tsx::Empty > has no outline with variant=plain, and aligns to the start with align=start)
   */
  variant?: "outline" | "plain" | (string & { 'Use "outline" or "plain"': never }) | undefined;
  /**
   * `center` centers everything, for a page or panel; `start` lines it up with the text
   * around it (flush with it when `variant="plain"`, with no room at its sides).
   * @default "center"
   * @claim "`center` centers everything, for a page" registry/ouro/components/ouro/empty/empty.test.tsx verify:testExists(registry/ouro/components/ouro/empty/empty.test.tsx::Empty > lines its text up with the text around it with variant=plain and align=start, in either direction)
   * @claim "`center` centers everything, for a page" registry/ouro/components/ouro/empty/empty.test.tsx verify:testExists(registry/ouro/components/ouro/empty/empty.test.tsx::Empty > centers its content and draws a dashed outline by default)
   * @claim "`center` centers everything, for a page" registry/ouro/components/ouro/empty/empty.test.tsx verify:testExists(registry/ouro/components/ouro/empty/empty.test.tsx::Empty > has no outline with variant=plain, and aligns to the start with align=start)
   */
  align?: "center" | "start" | (string & { 'Use "center" or "start": left is "start"': never }) | undefined;
  /** Layout only: margins, width (`max-w-md` holds the whole Empty to a column), grid placement (`mt-6`). Appearance classes warn in development; use `variant`. */
  className?: string | undefined;
  ref?: Ref<HTMLDivElement> | undefined;

  /** Not a prop. Ouro UI uses `title`: `<Empty title="No recipes yet">`. */
  heading?: { 'Use <Empty title="No recipes yet">': never };
  /** Not a prop. Ouro UI uses `description`: `<Empty description="Add one.">`. */
  message?: { 'Use <Empty description="Add one.">': never };
  /** Not a prop. Ouro UI uses `action`, one slot: `<Empty action={<Button>Add</Button>}>`. */
  actions?: { "Use <Empty action={<Button>Add</Button>}>": never };
  /** Not a prop. Ouro UI uses `icon`: `<Empty icon={<Icon />}>`. */
  image?: { "Use <Empty icon={<Icon />}>": never };
}

/** Props for {@link Empty}: its own props and the div attributes it passes through. */
export type EmptyProps = Omit<HTMLAttributes<HTMLDivElement>, keyof EmptyOwnProps> & EmptyOwnProps;

const variants = { outline: "border border-dashed border-border rounded-ouro-xl", plain: "" } as const;
const aligns = { center: "items-center text-center", start: "items-start text-start" } as const;
const levels = [2, 3, 4, 5, 6] as const;

/**
 * What a list, search or page shows when it has nothing in it: an icon, a title that says
 * what is empty, a sentence on what to do, and the action that does it.
 *
 * Use `Alert` instead for an error or a warning, `Skeleton` while the content is
 * still loading, and `Moment` for a state with art of its own, a first run, a success that
 * celebrates, or one the person can dismiss.
 *
 * Signed out, show the way in (a "You're signed out" title and a Sign in action) instead of
 * the empty state a signed-in person would see, which tells a signed-out person nothing is
 * wrong. Mark the app's shell `data-ouro-session="signed-out"` and Ouro check's
 * `signed-out-empty` fails an Empty, or words that say there is nothing, under it, unless the
 * Empty holds the way in: `<Empty title="You're signed out" action={<Button>Sign in</Button>} />` passes.
 *
 * @claim "Ouro check's `signed-out-empty` fails an Empty" test/check-first-run-in-page.test.ts verify:testExists(test/check-first-run-in-page.test.ts::findFirstRunIssues: signed-out-empty > finds an Ouro Empty or words that say there is nothing, on a signed-out page, once per empty state)
 * @group Display
 * @see https://ui.ouroboros.bot/docs/empty
 *
 * @example
 * <Empty
 *   icon={<BookIcon />}
 *   title="No recipes yet"
 *   description="Start by creating your first recipe."
 *   action={<Button href="/recipes/new">Create recipe</Button>}
 * />
 */
export function Empty(props: EmptyProps): JSX.Element {
  const {
    title,
    description,
    icon,
    action,
    children,
    headingLevel = 3,
    variant: variantProp = "outline",
    align: alignProp = "center",
    className,
    heading,
    message,
    actions,
    image,
    ...rest
  } = props;
  const level = (levels as readonly unknown[]).includes(headingLevel) ? (headingLevel as (typeof levels)[number]) : 3;
  const variant = Object.hasOwn(variants, variantProp) ? (variantProp as keyof typeof variants) : "outline";
  const align = Object.hasOwn(aligns, alignProp) ? (alignProp as keyof typeof aligns) : "center";
  useAppearanceClassNameCheck(
    "Empty",
    className,
    process.env.NODE_ENV !== "production" ? '<Empty variant="plain"> inside a <Card>' : /* istanbul ignore next @preserve -- production only */ "",
    process.env.NODE_ENV !== "production" ? '<Empty align="start">' : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  useDevWarnings(
    "Empty",
    process.env.NODE_ENV !== "production"
      ? () => [
          !title && ["title is required; it says what is empty", '<Empty title="No recipes yet">'],
          level !== headingLevel && [`headingLevel must be 2, 3, 4, 5 or 6, got ${String(headingLevel)}`, "<Empty headingLevel={2}>"],
          variant !== variantProp && [`variant="${String(variantProp)}" is not a variant; use "outline", "plain"`, '<Empty variant="outline">'],
          align !== alignProp && [`align="${String(alignProp)}" is not an alignment; use "center", "start"`, '<Empty align="start">'],
          heading !== undefined && ["heading is not a prop", `<Empty title="${String(heading)}">`],
          message !== undefined && ["message is not a prop", `<Empty description="${String(message)}">`],
          actions !== undefined && ["actions is not a prop", "<Empty action={<Button>…</Button>}>"],
          image !== undefined && ["image is not a prop", "<Empty icon={<Icon />}>"],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  return (
    <div
      {...rest}
      data-ouro="empty"
      className={cn(
        "flex min-w-0 flex-col gap-4 py-10 text-balance",
        // With no edge and its text at the start, it lines up with the text around it; otherwise it keeps room at its sides.
        !(variant === "plain" && align === "start") && "px-6",
        variants[variant],
        aligns[align],
        className,
      )}
    >
      {icon && (
        <div
          aria-hidden="true"
          className="flex size-ouro-12 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground *:[svg]:size-ouro-6"
        >
          {icon}
        </div>
      )}
      <div className={cn("flex flex-col gap-1.5", aligns[align])}>
        <Heading level={level} size="md">
          {title}
        </Heading>
        {description && (
          <Text as="div" size="sm" tone="muted">
            {description}
          </Text>
        )}
      </div>
      {action && <div className="flex flex-wrap gap-2">{action}</div>}
      {children && <div className="w-full">{children}</div>}
    </div>
  );
}
