export { lastInput };

// The keys that move focus, as in Fluent's keyborg. Shift+Tab is Tab with a modifier.
const focusKeys = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

/** The marks ouro-base's keyboard-only focus rings read, while focus came from a press: on the focused element, and on the elements around it. */
const PRESSED_FOCUS = "data-ouro-pressed-focus";
const PRESSED_WITHIN = "data-ouro-pressed-within";

// The modality of the last press or key that moves focus, once there has been one.
let current: "keyboard" | "pointer" | undefined;

// Marks an element that has focus after a press, and the elements around it, and unmarks them after a key that moves
// focus: attributes on the focused element and its ancestors, so a switch between keyboard and pointer restyles them, not
// every element a rule on <html> reaches (#2524). The fields' rules read the ancestors' mark rather than a :has() on the
// focused one, because a :has() on an attribute that changes restyles far more than its subjects (an open X-ray's outlines).
function mark(element: EventTarget | null, pressed = current === "pointer"): void {
  // The page itself holds focus when nothing does; it is no control and draws no ring.
  if (!(element instanceof Element) || element === document.body) return;
  // Forced, toggleAttribute writes only when a mark changes, so a press on an element already marked restyles nothing.
  element.toggleAttribute(PRESSED_FOCUS, pressed);
  for (let around = element.parentElement; around && around !== document.body; around = around.parentElement) around.toggleAttribute(PRESSED_WITHIN, pressed);
}

// Written to <html> only when it changes, and only after the first press or key: the server HTML and the
// first client render carry no attribute, so hydration never differs, and reading it forces no layout. No Ouro rule
// reads it; the focused element's mark is what the focus rings follow.
function modality(next: "keyboard" | "pointer"): void {
  current = next;
  const root = document.documentElement;
  if (root.getAttribute("data-ouro-modality") !== next) root.setAttribute("data-ouro-modality", next);
  mark(document.activeElement);
}

// The pointer type of the last `pointerdown` (or mouse or pen `pointermove`) on the document, or "keyboard" after a later key press.
let input = "";

/**
 * How the user last interacted with the page: "mouse", "touch" or "pen" (the last
 * `pointerdown`, or a mouse or pen moving), "keyboard" after a later key press, or ""
 * before any of these.
 * Overlays read it when they open: a controlled `Dialog` focuses its popup rather
 * than its first input after a tap (the app's own button opened it, so Dialog never
 * saw the press), and a `Tooltip` never opens after a touch.
 *
 * The same listeners keep `data-ouro-modality="keyboard"` or `"pointer"` on `<html>`: `pointer` after a press and
 * `keyboard` after a key that moves focus (Tab and Shift+Tab, the arrows, Home, End, Page Up, Page Down), as in Fluent's
 * keyborg; Escape, Enter, a shortcut or a typed character leaves it as it was. For `ouro-base`'s keyboard-only focus rings
 * they mark the focused element with `data-ouro-pressed-focus` while its focus came from a press. Before either, the
 * browser's own `:focus-visible` decides. Moving the mouse changes neither.
 *
 * Internal: Ouro UI components use it; apps don't need to.
 *
 * @example
 * const tapped = lastInput() === "touch" || lastInput() === "pen";
 * @claim "Overlays read it when they open" registry/ouro/lib/ouro/last-input.test.ts verify:testExists(registry/ouro/lib/ouro/last-input.test.ts::records the pointer type of a press, and keyboard after a key press)
 * @claim "Overlays read it when they open" registry/ouro/components/ouro/dialog/dialog.touch.test.tsx verify:testExists(registry/ouro/components/ouro/dialog/dialog.touch.test.tsx::initial focus in a controlled dialog opened from the app's own button > focuses the centered popup, not its first input, after a tap)
 */
function lastInput(): string {
  return input;
}

// From module load, not from the first overlay's mount: an app that mounts its Dialog on
// the tap that opens it (`{editing && <Dialog open … />}`) must still see that tap. The
// capture phase means nothing can stop it.
/* istanbul ignore else @preserve -- the else path is server rendering, which has no document */
if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    (event) => {
      input = event.pointerType;
      modality("pointer");
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      input = "keyboard";
      // Only a key that moves focus shows the keyboard is steering: Escape, Enter, a shortcut such as ⌘K or a typed character is not.
      if (focusKeys.has(event.key)) modality("keyboard");
    },
    true,
  );
  // Focus that lands takes the mark the last press or key calls for; focus that leaves takes none away with it.
  document.addEventListener("focusin", (event) => mark(event.target), true);
  document.addEventListener(
    "focusout",
    (event) => {
      mark(event.target, false);
    },
    true,
  );
  // A moving mouse or pen is in use again, so a device with both a touchscreen and a
  // trackpad gets its hover back after a tap. Touch moves only during a press.
  document.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType === "mouse" || event.pointerType === "pen") input = event.pointerType;
    },
    true,
  );
}
