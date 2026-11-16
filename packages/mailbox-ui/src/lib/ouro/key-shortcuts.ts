export { ariaKeyShortcuts };

/** Kbd's key names, as `aria-keyshortcuts` spells them (UI Events key values). `mod` is listed both ways. */
const names: Readonly<Record<string, readonly string[]>> = {
  mod: ["Control", "Meta"],
  cmd: ["Meta"],
  command: ["Meta"],
  meta: ["Meta"],
  ctrl: ["Control"],
  control: ["Control"],
  alt: ["Alt"],
  option: ["Alt"],
  shift: ["Shift"],
  up: ["ArrowUp"],
  down: ["ArrowDown"],
  left: ["ArrowLeft"],
  right: ["ArrowRight"],
  arrowup: ["ArrowUp"],
  arrowdown: ["ArrowDown"],
  arrowleft: ["ArrowLeft"],
  arrowright: ["ArrowRight"],
  esc: ["Escape"],
  escape: ["Escape"],
  enter: ["Enter"],
  return: ["Enter"],
  del: ["Delete"],
  delete: ["Delete"],
  space: ["Space"],
};

/**
 * The `aria-keyshortcuts` value for Kbd-style keys: `["mod", "shift", "e"]` is
 * `"Control+Shift+E Meta+Shift+E"`, because `mod` is ⌘ on Apple platforms and Ctrl elsewhere,
 * and the server cannot tell which. A letter is upper case; another key's first letter is
 * (`backspace` is `Backspace`).
 */
function ariaKeyShortcuts(keys: readonly string[]): string {
  let combos: string[][] = [[]];
  for (const key of keys) {
    const options = names[key.toLowerCase()] ?? [key.charAt(0).toUpperCase() + key.slice(1)];
    combos = combos.flatMap((combo) => options.map((option) => [...combo, option]));
  }
  return combos.map((combo) => combo.join("+")).join(" ");
}
