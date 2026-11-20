const seenMessages = new Set<string>();
const seenByKey = new WeakMap<object, Set<string>>();

const tidy = (text: string) => text.replace(/\.$/, "");

function format(component: string, problem: string, fix: string): string {
  return `[ouro-ui] ${component}: ${tidy(problem)}. Fix: ${tidy(fix)}.`;
}

/**
 * Logs one development-only warning in the format
 * `[ouro-ui] <Component>: <what's wrong>. Fix: <exact code>.`
 *
 * With a `key` (use a per-instance ref object) the warning is emitted once per
 * key and message; without one, once per message text. In production it does nothing.
 *
 * The check is the bare `process.env.NODE_ENV !== "production"` form, which
 * bundlers replace statically. Guard the call site the same way so the message
 * strings are removed from production builds too.
 *
 * @example
 * if (process.env.NODE_ENV !== "production") {
 *   devWarn("Button", '"bg-red-500" sets appearance', 'tone="destructive"', ref);
 * }
 */
export function devWarn(component: string, problem: string, fix: string, key?: object): void {
  /* istanbul ignore else @preserve -- the else path exists only in production bundles; scripts/dev-strip.test.mjs covers it */
  if (process.env.NODE_ENV !== "production") {
    const message = format(component, problem, fix);
    if (key) {
      let seen = seenByKey.get(key);
      if (!seen) {
        seen = new Set();
        seenByKey.set(key, seen);
      }
      if (seen.has(message)) return;
      seen.add(message);
    } else {
      if (seenMessages.has(message)) return;
      seenMessages.add(message);
    }
    console.warn(message);
  }
}

/**
 * Throws an `Error` for a misuse that cannot be recovered from. In development
 * the message teaches the fix; in production it is shortened to
 * `[ouro-ui] <Component>: <problem>`.
 *
 * Build the `fix` argument only in development so its text is stripped from
 * production builds.
 *
 * @example
 * devThrow(
 *   "Sheet.Title",
 *   "must be rendered inside <Sheet>",
 *   process.env.NODE_ENV !== "production" ? '<Sheet title="…">…</Sheet>' : "",
 * );
 */
export function devThrow(component: string, problem: string, fix: string): never {
  /* istanbul ignore else @preserve -- the else path exists only in production bundles; scripts/dev-strip.test.mjs covers it */
  if (process.env.NODE_ENV !== "production") {
    throw new Error(format(component, problem, fix));
  } else {
    throw new Error(`[ouro-ui] ${component}: ${problem}`);
  }
}

/**
 * Marks the page as checked, on `window`, so two copies of this module still check once.
 *
 * @claim "Marks the page as checked, on" registry/ouro/lib/ouro/dev.test.ts verify:testExists(registry/ouro/lib/ouro/dev.test.ts::checkTheme > names the command that adds ouro-base, once per page, when the token is unset)
 */
const THEME_CHECKED = Symbol.for("ouro-ui.theme-checked");

/**
 * Checks once per page, in development, that the app's CSS has `ouro-base`, and logs the
 * command that adds it when it does not. No component installs `ouro-base`, and without it
 * nothing fails: a sheet has no backdrop, layer or motion and a field no border.
 * `--ouro-layer` on the document root stands for the whole item, because only `ouro-base`
 * defines it. A page still loading its stylesheets is checked when it has loaded.
 *
 * Internal: `useDevWarnings` calls it when the first Ouro UI component mounts.
 *
 * @example
 * if (process.env.NODE_ENV !== "production") checkTheme();
 * @claim "No component installs `ouro-base`, and without" scripts/registry.test.mjs verify:testExists(scripts/registry.test.mjs::only ouro-base, ouro-plain and ouro-theme touch the app's stylesheet, and no other item installs them)
 * @claim "No component installs `ouro-base`, and without" registry/ouro/lib/ouro/dev.test.ts verify:testExists(registry/ouro/lib/ouro/dev.test.ts::checkTheme > names the command that adds ouro-base, once per page, when the token is unset)
 */
export function checkTheme(): void {
  /* istanbul ignore else @preserve -- the else path exists only in production bundles; scripts/dev-strip.test.mjs covers it */
  if (process.env.NODE_ENV !== "production") {
    const page = window as unknown as Record<symbol, boolean | undefined>;
    if (page[THEME_CHECKED]) return;
    page[THEME_CHECKED] = true;
    const check = () => {
      if (getComputedStyle(document.documentElement).getPropertyValue("--ouro-layer").trim() !== "") return;
      devWarn(
        "theme",
        "ouro-base is not in this page's CSS (--ouro-layer is unset), so overlays have no backdrop, layer or motion and fields have no border",
        "npx shadcn@latest add ourostack/ouro-ui/ouro-base#v1.3.353",
      );
    };
    if (document.readyState === "complete") check();
    else window.addEventListener("load", check, { once: true });
  }
}
