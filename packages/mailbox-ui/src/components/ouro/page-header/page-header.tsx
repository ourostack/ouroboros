"use client";

import type { HTMLAttributes, JSX, ReactNode, Ref } from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { cn } from "@/lib/ouro/cn";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import { Heading } from "@/components/ouro/text/heading";

/** The props PageHeader adds to the `<div>` attributes it passes through. */
export interface PageHeaderOwnProps {
  /** The page's title, its `<h1>` (or `<h2>` with `level={2}`). */
  title: ReactNode;
  /** A short line above the title that says what kind of page this is or where it sits: "Settings", "Project". */
  eyebrow?: ReactNode;
  /** A short sentence under the title. */
  description?: ReactNode;
  /** The page's actions, such as Edit and Share buttons: at the end of the title on wide screens, under it on phones. */
  actions?: ReactNode;
  /**
   * A trail above everything else, such as a `Breadcrumb`.
   *
   * @claim "A trail above everything else, such" registry/ouro/components/ouro/page-header/page-header.test.tsx verify:testExists(registry/ouro/components/ouro/page-header/page-header.test.tsx::PageHeader > puts the trail and the image above the title, the image at full width)
   */
  breadcrumb?: ReactNode;
  /**
   * An image or illustration above the title, at the header's full width with rounded corners.
   * Give an `<img>` its `alt`, or `alt=""` when the title already says what it shows.
   */
  media?: ReactNode;
  /** More under the description, such as badges or a byline. */
  children?: ReactNode;
  /**
   * The title's heading level. `1` for the page title; `2` when the header heads a section
   * inside a page that already has its `<h1>`. @default 1
   */
  level?: 1 | 2 | (number & { 'Use 1 for the page title or 2 for a section': never }) | undefined;
  /** How large the title is: `md` for an app page, `lg` for a landing or profile page. @default "md" */
  size?: "md" | "lg" | (string & { 'Use "md" or "lg"': never }) | undefined;
  /** A line under the header, between it and the page's content. */
  divider?: boolean | undefined;
  /** Layout only: margins, width (`mb-8`, `max-w-5xl`). Appearance classes warn in development. */
  className?: string | undefined;
  ref?: Ref<HTMLDivElement> | undefined;

  /** Not a prop. The text under the title is `description`: `<PageHeader title="…" description="…" />`. */
  subtitle?: { 'Use <PageHeader description="..." />': never };
  /** Not a prop. The text above the title is `eyebrow`: `<PageHeader eyebrow="Settings" title="…" />`. */
  overline?: { 'Use <PageHeader eyebrow="Settings" />': never };
  /** Not a prop. The buttons are `actions`: `<PageHeader actions={<Button>Edit</Button>} />`. */
  action?: { 'Use actions={<Button>Edit</Button>}': never };
  /** Not a prop. The image is `media`: `<PageHeader media={<img src={src} alt="" />} />`. */
  image?: { 'Use media={<img src={src} alt="" />}': never };
  /** Not a prop. The title is `title`: `<PageHeader title="Billing" />`. */
  heading?: { 'Use <PageHeader title="Billing" />': never };
}

/** Props for {@link PageHeader}: its own props and the `<div>` attributes it passes through. */
export type PageHeaderProps = Omit<HTMLAttributes<HTMLDivElement>, keyof PageHeaderOwnProps> & PageHeaderOwnProps;

/**
 * The top of a page: its title with an optional line above it (`eyebrow`), a description
 * under it, the page's actions beside it, and a trail and an image above. On phones the
 * actions move under the title. The title is the page's `<h1>`, in the theme's heading font;
 * with `level={2}` the header heads a section instead.
 *
 * Use `Heading` instead for a plain title with nothing around it, and `Card` for a block of
 * content with its own title inside a page.
 *
 * @group Layout
 * @see https://ui.ouroboros.bot/docs/page-header
 *
 * @example
 * <PageHeader
 *   eyebrow="Settings"
 *   title="Billing"
 *   description="Your plan, invoices and payment method."
 *   actions={<Button>Change plan</Button>}
 * />
 */
export function PageHeader(props: PageHeaderProps): JSX.Element {
  const {
    title,
    eyebrow,
    description,
    actions,
    breadcrumb,
    media,
    children,
    level: levelProp = 1,
    size: sizeProp = "md",
    divider,
    className,
    // Guard props (hint types), dropped here so they never reach the DOM.
    subtitle,
    overline,
    action,
    image,
    heading,
    ...rest
  } = props;
  const level = levelProp === 2 ? 2 : 1;
  const size = sizeProp === "lg" ? "lg" : "md";
  useAppearanceClassNameCheck(
    "PageHeader",
    className,
    process.env.NODE_ENV !== "production"
      ? (token: string) => `remove "${token}"; PageHeader sets its own look from the theme`
      : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "PageHeader",
    process.env.NODE_ENV !== "production"
      ? () => [
          level !== levelProp && [`level={${String(levelProp)}} is not a level; use 1 or 2`, "<PageHeader level={2} />"],
          size !== sizeProp && [`size="${String(sizeProp)}" is not a size; use "md" or "lg"`, '<PageHeader size="lg" />'],
          subtitle !== undefined && ["subtitle is not a prop", `<PageHeader description="${typeof subtitle === "string" ? subtitle : "..."}" />`],
          overline !== undefined && ["overline is not a prop", `<PageHeader eyebrow="${typeof overline === "string" ? overline : "..."}" />`],
          action !== undefined && ["action is not a prop", "<PageHeader actions={<Button>Edit</Button>} />"],
          image !== undefined && ["image is not a prop", '<PageHeader media={<img src={src} alt="" />} />'],
          heading !== undefined && ["heading is not a prop", `<PageHeader title="${typeof heading === "string" ? heading : "..."}" />`],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );
  return (
    <div
      {...rest}
      data-ouro="page-header"
      data-size={size}
      className={cn("grid min-w-0 gap-4", divider && "border-0 border-b border-solid border-border pb-6", className)}
    >
      {breadcrumb != null ? (
        <div data-slot="breadcrumb" className="min-w-0">
          {breadcrumb}
        </div>
      ) : null}
      {media != null ? (
        <div data-slot="media" className="min-w-0 overflow-hidden rounded-ouro-lg bg-muted [&>img]:block [&>img]:h-full [&>img]:w-full [&>img]:object-cover">
          {media}
        </div>
      ) : null}
      <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="grid min-w-0 gap-2">
          {eyebrow != null ? (
            <p data-slot="eyebrow" className={"m-0 text-sm leading-5 font-medium text-muted-foreground"}>
              {eyebrow}
            </p>
          ) : null}
          <Heading level={level} size={size === "lg" ? "display" : level === 1 ? "2xl" : "xl"} className="min-w-0 break-words">
            {title}
          </Heading>
          {description != null ? (
            <div data-slot="description" className={"max-w-prose text-base leading-7 text-muted-foreground"}>
              {description}
            </div>
          ) : null}
          {children != null ? <div className="min-w-0 pt-1">{children}</div> : null}
        </div>
        {actions != null ? (
          <div data-slot="actions" className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
