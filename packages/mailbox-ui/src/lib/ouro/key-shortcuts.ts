import type { Platform } from "@/lib/ouro/platform";

export { ariaKeyShortcuts };

/** Kbd's key names, as `aria-keyshortcuts` spells them (UI Events key values). `mod` has its own rule, in `modNames`. */
const names: Readonly<Record<string, readonly string[]>> = {
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
 * `mod` is ⌘ (`Meta`) on Apple platforms and Ctrl elsewhere. Before the platform is known, as on
 * the server, it is both, so the server's HTML names each.
 * @claim "`mod` is ⌘ (`Meta`) on Apple platforms" registry/ouro/lib/ouro/key-shortcuts.test.ts verify:testExists(registry/ouro/lib/ouro/key-shortcuts.test.ts::ariaKeyShortcuts > names mod as the platform's own modifier on %s)
 * @claim "it is both, so the server's HTML names each" registry/ouro/lib/ouro/key-shortcuts.test.ts verify:testExists(registry/ouro/lib/ouro/key-shortcuts.test.ts::ariaKeyShortcuts > names mod both ways while the platform is unknown, as the server's HTML does)
 */
function modNames(platform: Platform): readonly string[] {
  if (platform === "apple") return ["Meta"];
  return platform === "unknown" ? ["Control", "Meta"] : ["Control"];
}

/**
 * The `aria-keyshortcuts` value for Kbd-style keys. Given the platform (from `usePlatform`),
 * `["mod", "shift", "e"]` is `"Meta+Shift+E"` on Apple and `"Control+Shift+E"` elsewhere. Without
 * one, which is the server's HTML, it lists both: `"Control+Shift+E Meta+Shift+E"`, since the server
 * cannot tell which. A letter is upper case; another key's first letter is (`backspace` is `Backspace`).
 * @claim "Given the platform (from `usePlatform`)" registry/ouro/lib/ouro/key-shortcuts.test.ts verify:testExists(registry/ouro/lib/ouro/key-shortcuts.test.ts::ariaKeyShortcuts > names mod as the platform's own modifier on %s)
 * @claim "Without one, which is the server's HTML" registry/ouro/lib/ouro/key-shortcuts.test.ts verify:testExists(registry/ouro/lib/ouro/key-shortcuts.test.ts::ariaKeyShortcuts > names mod both ways while the platform is unknown, as the server's HTML does)
 * @claim "A letter is upper case" registry/ouro/lib/ouro/key-shortcuts.test.ts verify:testExists(registry/ouro/lib/ouro/key-shortcuts.test.ts::ariaKeyShortcuts > lists mod both ways, upper-cases letters and keeps other characters)
 *
 * @example
 * ariaKeyShortcuts(["mod", "shift", "e"], platform);
 */
function ariaKeyShortcuts(keys: readonly string[], platform: Platform = "unknown"): string {
  let combos: string[][] = [[]];
  for (const key of keys) {
    const lower = key.toLowerCase();
    const options = lower === "mod" ? modNames(platform) : (names[lower] ?? [key.charAt(0).toUpperCase() + key.slice(1)]);
    combos = combos.flatMap((combo) => options.map((option) => [...combo, option]));
  }
  return combos.map((combo) => combo.join("+")).join(" ");
}
