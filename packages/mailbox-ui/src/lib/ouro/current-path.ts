export { currentHref, currentTabHref, samePath };

/**
 * The path of an `href` or a pathname: no query, no hash, no trailing slash (the root stays `/`).
 *
 * @claim "The path of an `href` or" registry/ouro/lib/ouro/current-path.test.ts verify:testExists(registry/ouro/lib/ouro/current-path.test.ts::currentHref > matches the same path, ignoring a trailing slash, a query and a hash)
 */
function pathOf(href: string): string {
  const path = href.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return path === "" ? "/" : path;
}

/**
 * Picks which of a navigation's `hrefs` is the current page for `currentPath` (your
 * router's pathname): the one with the same path, or else the longest one the path sits
 * under, so `/recipes/12` marks `/recipes`. The root `/` matches only itself. Returns
 * `undefined` when none matches or there is no `currentPath`.
 *
 * @internal Shared by Navbar, Sidebar and NavigationMenu; apps pass `currentPath`.
 * @example
 * currentHref(["/", "/recipes", "/settings"], "/recipes/12"); // "/recipes"
 * @claim "Returns `undefined` when none matches or" registry/ouro/lib/ouro/current-path.test.ts verify:testExists(registry/ouro/lib/ouro/current-path.test.ts::currentHref > returns nothing without a current path)
 */
function currentHref(hrefs: readonly string[], currentPath: string | undefined): string | undefined {
  if (currentPath === undefined) return undefined;
  const path = pathOf(currentPath);
  let best: string | undefined;
  let bestLength = -1;
  for (const href of hrefs) {
    const candidate = pathOf(href);
    if (candidate === path) return href;
    if (candidate !== "/" && path.startsWith(`${candidate}/`) && candidate.length > bestLength) {
      best = href;
      bestLength = candidate.length;
    }
  }
  return best;
}

/**
 * Whether `href` is the page at `currentPath` itself, rather than a page above it: the same path, ignoring a trailing
 * slash, a query and a hash. A navigation marks that link `aria-current="page"`, and the link of the section a deeper
 * page is in `aria-current="true"`.
 *
 * @internal Shared by Navbar and NavigationMenu; apps pass `currentPath`.
 * @example
 * samePath("/recipes", "/recipes/?sort=new"); // true
 * samePath("/recipes", "/recipes/12"); // false
 * @claim "Whether `href` is the page" registry/ouro/lib/ouro/current-path.test.ts verify:testExists(registry/ouro/lib/ouro/current-path.test.ts::samePath > is the page itself, ignoring a trailing slash, a query and a hash, and not a page above it)
 */
function samePath(href: string, currentPath: string | undefined): boolean {
  return currentPath !== undefined && pathOf(href) === pathOf(currentPath);
}

/** An `href`'s query, without its hash. */
function queryOf(href: string): URLSearchParams {
  return new URLSearchParams(href.split("#")[0]!.split("?")[1]);
}

/**
 * Picks which of a set of link tabs' `hrefs` is the current page for `currentPath`, your
 * router's path with its query (`pathname + search`). Tabs at the current path match by
 * query: the one whose every parameter the current path carries, the one with the most
 * parameters winning, so `/search?scope=recipes&q=soup` marks `/search?scope=recipes` and
 * `/search?q=soup` marks `/search`. When no tab is at the current path, the longest one the
 * path sits under matches, as in `currentHref`.
 *
 * @internal Used by Tabs' link mode; apps pass `currentPath`.
 * @example
 * currentTabHref(["/search", "/search?scope=recipes"], "/search?scope=recipes&q=soup"); // "/search?scope=recipes"
 * @claim "Tabs at the current path match" registry/ouro/lib/ouro/current-path.test.ts verify:testExists(registry/ouro/lib/ouro/current-path.test.ts::currentTabHref > marks the tab whose every parameter the current path carries, the most parameters winning)
 * @claim "When no tab is at the" registry/ouro/lib/ouro/current-path.test.ts verify:testExists(registry/ouro/lib/ouro/current-path.test.ts::currentTabHref > falls back to the longest tab the path sits under when none is at its path)
 */
function currentTabHref(hrefs: readonly string[], currentPath: string | undefined): string | undefined {
  if (currentPath === undefined) return undefined;
  const path = pathOf(currentPath);
  const here = queryOf(currentPath);
  const atPath = hrefs.filter((href) => pathOf(href) === path);
  if (atPath.length === 0) return currentHref(hrefs, currentPath);
  let best: string | undefined;
  let bestCount = -1;
  for (const href of atPath) {
    const query = [...queryOf(href)];
    if (query.length > bestCount && query.every(([name, value]) => here.getAll(name).includes(value))) {
      best = href;
      bestCount = query.length;
    }
  }
  return best;
}
