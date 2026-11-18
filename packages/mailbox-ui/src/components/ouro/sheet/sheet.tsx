"use client";

import type { JSX, ReactElement, ReactNode } from "react";
import { useAppearanceClassNameCheck } from "@/lib/ouro/class-name-check";
import { checkOpenMode, type TriggerOrOpen } from "@/lib/ouro/open-mode";
import { TouchTarget } from "@/lib/ouro/touch-target";
import { useDevWarnings } from "@/lib/ouro/use-dev-messages";
import {
  SheetBackdrop,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHandle,
  SheetPopupUnchecked,
  SheetPortal,
  SheetRoot,
  SheetTitle,
  SheetTrigger,
  SheetViewport,
  type SheetPopupProps,
  type SheetSnapPoint,
} from "@/components/ouro/sheet/sheet-parts";
import { footerClass, sheetHint, sheetSides, sideWarning, type SheetSide } from "@/components/ouro/sheet/sheet-styles";

export type { SheetSide, SheetSnapPoint } from "@/components/ouro/sheet/sheet-parts";

/** Props shared by both ways of opening a Sheet. */
export interface SheetBaseProps {
  /**
   * Names the sheet for screen readers and shows at its top. Always required; hide it with `hideTitle`.
   *
   * @claim "Always required; hide it with `hideTitle`" registry/ouro/components/ouro/sheet/sheet.test-d.ts verify:fileLine(registry/ouro/components/ouro/sheet/sheet.test-d.ts, /\{\strigger:\sReactElement;\schildren:\s"Body"\s\}>\(\)\.not\.toExtend<SheetProps>/)
   */
  title: string;
  /** Hides the title visually. It still names the dialog for screen readers. */
  hideTitle?: boolean | undefined;
  /**
   * The label of the sheet's close button: an icon button in the top corner, in view, with a
   * 44px target on a touch screen, as Dialog's is, so a mouse user sees how to close the sheet
   * and a phone's screen reader (which has no Escape key) can always close it. It is the last
   * control in the sheet. Escape and a press on the backdrop close it too. With `hideTitle`
   * the button sits over the body's top corner, so leave that corner clear. @default "Close"
   * @claim "an icon button in the top corner, in view" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::close control > shows a Close icon button in the top corner without focus, last in the sheet, that closes it)
   */
  closeLabel?: string | undefined;
  /** A short line under the title, read out when the sheet opens. */
  description?: ReactNode;
  /** The edge the sheet slides in from and is dragged back to. @default "bottom" */
  side?: SheetSide | (string & { 'Use "bottom", "top", "left" or "right"': never }) | undefined;
  /**
   * Heights a bottom or top sheet rests at, smallest first: fractions of the
   * viewport (`0.5`), `px` or `rem`. `snapPoints={[0.5, 1]}` opens at half
   * height and drags up to full. Without snap points the sheet fits its content.
   * @claim "Heights a bottom or top sheet" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::feel > opens at the first snap point, as a fraction of the viewport)
   * @claim "Heights a bottom or top sheet" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::feel > gives a top sheet with snap points the full height less the gap, and fits a top sheet without them)
   */
  snapPoints?: SheetSnapPoint[] | undefined;
  /**
   * Whether the sheet shuts off the rest of the page while it is open. `false` makes it a
   * panel beside a page the person keeps using, such as a live preview of a look: no backdrop,
   * no focus trap and no scroll lock, the page stays at full strength and in reach, and a press
   * or focus on the page leaves the sheet open, unless you pass `closeOnOutsidePress`. Escape, with focus in the sheet, and its close
   * button, shown at its top corner, close it. @default true
   * @claim "Whether the sheet shuts off the" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::non-modal sheet > draws no backdrop and leaves the page at full strength, in reach and scrolling)
   * @claim "Whether the sheet shuts off the" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::non-modal sheet > is a dialog without aria-modal, lets focus leave it, and stays open when focus or a press goes to the page)
   * @claim "makes it a panel beside" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::non-modal sheet > draws no backdrop and leaves the page at full strength, in reach and scrolling)
   * @claim "makes it a panel beside" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::non-modal sheet > is a dialog without aria-modal, lets focus leave it, and stays open when focus or a press goes to the page)
   * @claim "Escape, with focus in the sheet" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::non-modal sheet > closes on Escape from inside it, and from its close button, which shows at its top corner)
   * @claim "Whether the sheet shuts off the" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::non-modal sheet > stays modal by default, with its backdrop)
   */
  modal?: boolean | undefined;
  /**
   * Whether a press outside the sheet closes it. With `modal={false}`, `true` makes the panel
   * beside the page close when the person presses the page, so a press on another row both closes
   * it and reaches that row. Focus moving out of it closes it too, by Tab or from your code, so a
   * keyboard closes it as a press does, and focus stays where it went. Menus, popovers and dialogs
   * opened from inside the sheet are part of it, so a press in one of them leaves the sheet open.
   * `false` on a modal sheet keeps it open when its backdrop is pressed.
   * @default `true` for a modal sheet, `false` with `modal={false}`
   * @claim "With `modal={false}`, `true` makes the" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::non-modal sheet > with closeOnOutsidePress, closes on a press on the page, and the press still reaches the page)
   * @claim "Menus, popovers and dialogs opened from" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::non-modal sheet > with closeOnOutsidePress, stays open on a press in a menu or a dialog opened from inside it)
   * @claim "Focus moving out of it closes" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::non-modal sheet > with closeOnOutsidePress, closes when focus moves out of it by %s, and leaves focus where it went)
   * @claim "`false` on a modal sheet keeps it" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::non-modal sheet > closeOnOutsidePress={false} keeps a modal sheet open on a press on its backdrop)
   */
  closeOnOutsidePress?: boolean | undefined;
  /** The body. It scrolls when it is taller than the sheet. */
  children: ReactNode;
  /** The actions row, stacked full width on phones; primary action last. */
  footer?: ReactNode;
  /**
   * Layout only, applied to the sheet panel: width and margins (`max-w-lg`,
   * `mx-auto`). Your classes win over Ouro UI's. Appearance classes warn in development.
   */
  className?: string | undefined;

  /** Not a prop. Ouro UI uses `open` with `onOpenChange`: `<Sheet open={open} onOpenChange={setOpen}>`. */
  isOpen?: { 'Use <Sheet open={open} onOpenChange={setOpen}>': never };
  /** Not a prop. `onOpenChange(false)` fires on close: `<Sheet open={open} onOpenChange={setOpen}>`. */
  onClose?: { 'Use <Sheet open={open} onOpenChange={setOpen}>': never };
  /** Not a prop. Ouro UI uses `side`: `<Sheet side="bottom">`. */
  position?: { 'Use <Sheet side="bottom">': never };
  /** Not a prop. A sheet fits its content; to set heights use `snapPoints={[0.5, 1]}`. */
  size?: { 'Use <Sheet snapPoints={[0.5, 1]}>': never };
}

/** An uncontrolled Sheet: `trigger` opens it. */
export type SheetWithTriggerProps = SheetBaseProps & {
  /** The element that opens the sheet, usually a Button: `trigger={<Button>Save</Button>}`. */
  trigger: ReactElement;
  /** Not with `trigger`. Remove `trigger` to control the sheet with `open` and `onOpenChange`. */
  open?: TriggerOrOpen;
  /** Not with `trigger`. Remove `trigger` to control the sheet with `open` and `onOpenChange`. */
  onOpenChange?: never;
};

/** A controlled Sheet: you own `open` and update it in `onOpenChange`. */
export type SheetControlledProps = SheetBaseProps & {
  /** Whether the sheet is open. */
  open: boolean;
  /** Called with `false` when the user dismisses the sheet (swipe, Escape, outside press). */
  onOpenChange: (open: boolean) => void;
  /** Not with `open`. Remove `open` and `onOpenChange` to let a trigger open the sheet. */
  trigger?: never;
};

/** Props for {@link Sheet}: either `trigger`, or `open` with `onOpenChange`. */
export type SheetProps = SheetWithTriggerProps | SheetControlledProps;

/**
 * A panel that slides in from an edge and is dragged back to dismiss: the
 * mobile form of a dialog. It stretches when pulled past its edge, its backdrop
 * lightens as it is dragged away, and it springs back on release. It handles
 * focus, Escape, scroll locking, safe areas and the software keyboard.
 *
 * Use `trigger` for a sheet a button opens, or `open` with `onOpenChange` to
 * control it. Use `Dialog` instead when the content should be a centered
 * dialog on larger screens; it renders this sheet on phones. Use the page itself
 * (`AuthLayout`) instead for a step the person must take, such as signing in: a
 * person can always put a Sheet away, and Ouro check's `dismissable-step` fails one
 * over a blank page, or over a signed-out page with no way to sign in.
 *
 * To close the sheet from an action, control it (`open`/`onOpenChange`) and set
 * `open` to `false` in the handler, or wrap each action in `SheetClose`
 * (`import { SheetClose } from "@/components/ouro/sheet/sheet-parts"`, with your components alias):
 * `<SheetClose render={<Button>Copy link</Button>} />`.
 *
 * It stacks above the page at `--ouro-layer`, a z-index of 50 by default (from
 * ouro-base.css). If your app has fixed bars above z-50, raise it in a `:root` rule
 * of your own after the Ouro tokens, outside any `@layer`: `:root { --ouro-layer: 60; }`.
 * Don't edit the `--ouro-layer: 50` line shadcn wrote; `shadcn add` resets it.
 * Opened from inside a Sheet, it shows above it.
 *
 * Testing accessibility: in WebKit, Base UI's focus guards take `role="button"`
 * without a name so VoiceOver's cursor stays trapped. Exclude them:
 * `new AxeBuilder({ page }).exclude("[data-base-ui-focus-guard]")`.
 *
 * @claim "Ouro check's `dismissable-step` fails one" test/check-first-run-in-page.test.ts verify:testExists(test/check-first-run-in-page.test.ts::findFirstRunIssues: dismissable-step > finds a modal dialog that Escape or its close button puts away onto a blank page)
 * @group Overlays
 * @see https://ui.ouroboros.bot/docs/sheet
 *
 * @example
 * <Sheet title="Save to cookbook" trigger={<Button>Save</Button>}>
 *   <CookbookList />
 * </Sheet>
 * <Sheet title="Filters" open={open} onOpenChange={setOpen} snapPoints={[0.5, 1]}>
 *   <FilterForm />
 * </Sheet>
 * @claim "It stacks above the page at" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::Sheet stacking above the app's fixed bars > stays above a fixed app bar at the same level: a tie, which the portal wins as the last child of body)
 * @claim "Opened from inside a Sheet, it shows above it" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::sheet in a sheet > shows a Sheet opened from inside a Sheet above it, outer modal %s)
 * @claim "It stacks above the page at" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::Sheet stacking above the app's fixed bars > puts the portal on the --ouro-layer level, as its own stacking context)
 * @claim "It stacks above the page at" registry/ouro/theme/ouro-base.css verify:fileLine(registry/ouro/theme/ouro-base.css, /^\s+--ouro-layer:\s50;/)
 * @claim "Testing accessibility: in WebKit, Base UI's" test/axe-exclude.test.tsx verify:testExists(test/axe-exclude.test.tsx::matches the open dialog's focus guards, and with them excluded the accessibility gate finds nothing)
 * @claim "To close the sheet from an" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::footer > renders footer as the actions row after the body, and closes from an action wrapped in SheetClose)
 * @claim "To close the sheet from an" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::close control > takes its label from closeLabel and closes a controlled sheet through onOpenChange)
 */
export function Sheet(props: SheetProps): JSX.Element {
  const {
    title,
    hideTitle,
    closeLabel = "Close",
    description,
    side: sideProp = "bottom",
    snapPoints,
    modal,
    closeOnOutsidePress,
    children,
    footer,
    className,
    trigger,
    open,
    onOpenChange,
    // Guard props (hint types), dropped here so they never reach the DOM.
    isOpen,
    onClose,
    position,
    size,
  } = props as SheetBaseProps & {
    trigger?: ReactElement;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  };

  checkOpenMode("Sheet", "sheet", trigger !== undefined, open, onOpenChange);

  // A side that is not one of Ouro UI's (a type error) warns and renders a bottom sheet.
  const side = sheetSides.includes(sideProp as SheetSide) ? (sideProp as SheetSide) : "bottom";

  useAppearanceClassNameCheck(
    "Sheet",
    className,
    process.env.NODE_ENV !== "production"
      ? sheetHint('<Sheet title="…">', "</Sheet>")
      : /* istanbul ignore next @preserve -- production only */ "",
  );
  useDevWarnings(
    "Sheet",
    process.env.NODE_ENV !== "production"
      ? () => [
          !title && ["title is required; it names the sheet for screen readers", '<Sheet title="Share">'],
          side !== sideProp && sideWarning(String(sideProp), '<Sheet side="bottom">'),
          isOpen !== undefined && ["isOpen is not a prop", "<Sheet open={open} onOpenChange={setOpen}>"],
          onClose !== undefined && ["onClose is not a prop", "<Sheet open={open} onOpenChange={setOpen}>"],
          position !== undefined && ["position is not a prop", '<Sheet side="bottom">'],
          size !== undefined && ["size is not a prop; a sheet fits its content", "<Sheet snapPoints={[0.5, 1]}>"],
        ]
      : /* istanbul ignore next @preserve -- production only */ undefined,
  );

  return (
    <SheetFrame
      title={title}
      hideTitle={hideTitle}
      closeLabel={closeLabel}
      description={description}
      side={side}
      snapPoints={snapPoints}
      modal={modal}
      closeOnOutsidePress={closeOnOutsidePress}
      className={className}
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
      footer={footer}
    >
      {children}
    </SheetFrame>
  );
}

/**
 * The close button: in view at the top corner, as Dialog's is, with `TouchTarget` for a coarse pointer.
 */
const closeClass =
  "press absolute end-3 z-1 m-0 box-border inline-flex size-8 cursor-default items-center justify-center rounded-ouro-lg border-0 bg-transparent p-0 " +
  "text-muted-foreground outline-ring outline-offset-2 focus-visible:outline-2 focus-visible:outline-solid " +
  "pointer-fine:hover:bg-muted pointer-fine:hover:text-foreground motion-safe:active:scale-(--ouro-press-scale) " +
  "forced-colors:border forced-colors:border-solid disabled:cursor-not-allowed disabled:opacity-50";

/** Props for {@link SheetFrame}: a Sheet's props after its checks, plus what `Dialog` adds. */
export interface SheetFrameProps {
  title: string;
  hideTitle?: boolean | undefined;
  closeLabel: string;
  description?: ReactNode;
  side: SheetSide;
  snapPoints?: SheetSnapPoint[] | undefined;
  /**
   * The snap point the sheet rests at, held by the caller: `Command` keeps its phone sheet's size this way as results filter.
   * Passing it makes the Drawer controlled, which Base UI requires to change `snapPoints` after the sheet has opened.
   */
  snapPoint?: SheetSnapPoint | undefined;
  modal?: boolean | undefined;
  /** Whether a press outside closes the sheet (`Sheet`'s `closeOnOutsidePress`). @default `modal` */
  closeOnOutsidePress?: boolean | undefined;
  children: ReactNode;
  className?: string | undefined;
  /** The opening element. May come with `open`, when `Dialog` owns the state. */
  trigger?: ReactElement | undefined;
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** An actions row below the body (`Dialog`'s `footer`). */
  footer?: ReactNode;
  /** Marks the popup with `data-ouro-presentation`, when `Dialog` renders as a sheet. */
  presentation?: "sheet" | undefined;
  /** Where focus goes on close: `Dialog` passes its own trigger, which it renders outside the sheet, and `Command` a choice of its own. */
  finalFocus?: SheetPopupProps["finalFocus"];
  /** What takes focus as the sheet opens: `Command` puts it in its search after a key press or a click, and on the sheet itself after a touch or pen tap. */
  initialFocus?: SheetPopupProps["initialFocus"];
  /** Disables the close button, as `EditSheet` does while a save is pending. */
  closeDisabled?: boolean | undefined;
  /** Keeps the closed sheet's content in the page, hidden, so an open only shows it (`Navbar` builds its sheet ahead of the press). */
  keepMounted?: boolean | undefined;
  /** Called once an open or a close has finished, its slide included (`Navbar` builds its kept sheet afresh after a close). */
  onOpenChangeComplete?: ((open: boolean) => void) | undefined;
}

/**
 * The sheet's markup, without prop checks: `Sheet` renders it after its own
 * checks, and `Dialog` renders it on phones after Dialog's checks, so every dev
 * message names the component the app wrote.
 *
 * @internal Shared with `Dialog`; apps use `Sheet`.
 * @claim "The sheet's markup, without prop checks" registry/ouro/components/ouro/sheet/sheet.test.tsx verify:testExists(registry/ouro/components/ouro/sheet/sheet.test.tsx::Sheet dev messages > throws the exact fix when open comes without onOpenChange)
 * @claim "The sheet's markup, without prop checks" registry/ouro/components/ouro/dialog/dialog.test.tsx verify:testExists(registry/ouro/components/ouro/dialog/dialog.test.tsx::Dialog parts > renders the auto DialogPopup for a size that is not one of Ouro UI's, and warns once with the fix)
 */
export function SheetFrame({
  title,
  hideTitle,
  closeLabel,
  description,
  side,
  snapPoints,
  snapPoint,
  modal = true,
  closeOnOutsidePress = modal,
  children,
  className,
  trigger,
  open,
  onOpenChange,
  footer,
  presentation,
  finalFocus,
  initialFocus,
  closeDisabled,
  keepMounted,
  onOpenChangeComplete,
}: SheetFrameProps): JSX.Element {
  // A non-modal sheet keeps its header row, which its close button sits in, even with the title hidden.
  const showHeader = !hideTitle || description !== undefined || !modal;
  const titleNode = <SheetTitle visuallyHidden={hideTitle}>{title}</SheetTitle>;

  return (
    <SheetRoot
      side={side}
      snapPoints={snapPoints}
      snapPoint={snapPoint}
      modal={modal}
      disablePointerDismissal={!closeOnOutsidePress}
      {...(open !== undefined ? { open, onOpenChange: (next: boolean) => onOpenChange!(next) } : {})}
      {...(onOpenChangeComplete ? { onOpenChangeComplete } : {})}
    >
      {trigger !== undefined && <SheetTrigger render={trigger} />}
      <SheetPortal keepMounted={keepMounted}>
        {modal && <SheetBackdrop />}
        <SheetViewport>
          <SheetPopupUnchecked
            className={className}
            data-ouro-presentation={presentation}
            {...(finalFocus ? { finalFocus } : {})}
            initialFocus={initialFocus}
          >
            {side === "bottom" && <SheetHandle />}
            {showHeader ? (
              // The end padding keeps the title clear of the close button in the corner.
              <div data-ouro-sheet-header="" className="grid min-h-12 shrink-0 gap-1 ps-5 pe-14 pt-3 pb-2">
                {titleNode}
                {description !== undefined && <SheetDescription>{description}</SheetDescription>}
              </div>
            ) : (
              titleNode
            )}
            <SheetContent>{children}</SheetContent>
            {footer !== undefined && (
              <div data-ouro-footer="" className={footerClass}>
                {footer}
              </div>
            )}
            {side === "top" && <SheetHandle />}
            <SheetClose
              data-ouro-sheet-close=""
              disabled={closeDisabled}
              // Level with the title, which a bottom sheet's handle puts 21px lower; at the top corner when there is no title row.
              className={`${closeClass} ${side === "bottom" && showHeader ? "top-8.25" : "top-3"}`}
            >
              <TouchTarget />
              <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className="size-4">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span className="sr-only">{closeLabel}</span>
            </SheetClose>
          </SheetPopupUnchecked>
        </SheetViewport>
      </SheetPortal>
    </SheetRoot>
  );
}
