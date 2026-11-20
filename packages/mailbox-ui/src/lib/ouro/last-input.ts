export { lastInput };

// The keys that move focus, as in Fluent's keyborg. Shift+Tab is Tab with a modifier.
const focusKeys = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

// Written to <html> only when it changes, and only after the first press or key: the server HTML and the
// first client render carry no attribute, so hydration never differs, and reading it forces no layout.
function modality(next: "keyboard" | "pointer"): void {
  const root = document.documentElement;
  if (root.getAttribute("data-ouro-modality") !== next) root.setAttribute("data-ouro-modality", next);
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
 * The same listeners keep `data-ouro-modality="keyboard"` or `"pointer"` on `<html>` for `ouro-base`'s
 * keyboard-only focus rings: `pointer` after a press and `keyboard` after a key that moves focus (Tab and Shift+Tab, the arrows, Home, End, Page Up, Page Down), as in Fluent's keyborg; Escape, Enter, a shortcut or a typed character leaves it as it was. Before either, the
 * attribute is absent and the browser's own `:focus-visible` decides. Moving the mouse changes neither.
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
