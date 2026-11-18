export { findOffThemeIssues };

import type { PageIssue } from "./size-check.ts";

// Runs in the page (page.evaluate), so nothing in it may close over anything outside its function. A style an app wrote
// that bypasses its theme, read from the page's own style rules, whose specified values keep their var() references:
//
//   off-theme   a rule the app wrote sets a colour, a corner radius, a shadow or a font to a fixed value where the page
//               defines the theme token for it: a colour as hex, rgb(), oklch() or a name, or Tailwind's palette
//               (var(--color-red-500)) rather than the theme's colours; a radius in px or rem; a shadow of its own; a
//               font family by name. A theme change then never reaches it. The finding names the nearest token: the
//               closest theme colour, radius step or font, or the theme's shadows. A drawing's fills and strokes (in
//               an SVG) are its picture's own colours
//   off-scale   a rule the app wrote sets a padding, margin or gap to a fixed px or rem where Tailwind's --spacing step
//               is defined; the finding names the step. Spacing in em (it follows the text), fluid spacing (clamp(),
//               min(), max(), a viewport unit) and a hairline under half a step are left alone
//
// A property is judged only on a page that defines its token (a theme's --primary, --radius-md, --shadow-md or
// --font-sans, or Tailwind's --spacing), so a page with no theme has nothing to bypass.
//
// Ouro's components style themselves with Tailwind's utilities, in the utilities layer, and ship no stylesheet of their
// own. So a rule outside Tailwind's layers, or in its components layer, is the app's and is judged wherever it applies;
// a utility is judged only on an element outside every component root ([data-ouro]), where the app's own markup is.
// Tailwind's theme and base layers (its tokens and its reset) are left alone, and so are custom properties, which
// define tokens rather than use them; zero, auto, percentages and a pill's 9999px; and the system colours forced
// colours use. A rule is judged once, by its selector and property, on the first element it styles.
//
// The app's own variables are judged by what they hold, except one the theme's tokens are defined through
// (--muted: var(--color-undergrowth)) or one that holds a theme value (a colour a theme token is given, a radius step or
// a whole spacing step): the app names the theme there, as with --gutter: 1.5rem beside --spacing: 0.25rem. A fixed
// fallback a rule sets beside the same property through a variable (Tailwind's colour before its color-mix()) is
// the variable compiled, and is judged by the variable.
//
// An element opts out with data-ouro-allow="off-theme" (or "off-scale") and a reason in data-ouro-allow-why, as the other rules do.

interface OffThemeOptions {
  maxIssues?: number;
}

function findOffThemeIssues({ maxIssues = 40 }: OffThemeOptions = {}): PageIssue[] {
  const issues: PageIssue[] = [];
  const counter = window as unknown as { __ouroCheckRef?: number };
  const ref = (el: Element) => {
    counter.__ouroCheckRef = (counter.__ouroCheckRef ?? 0) + 1;
    const id = `o${counter.__ouroCheckRef}`;
    el.setAttribute("data-ouro-check-ref", `${el.getAttribute("data-ouro-check-ref") ?? ""} ${id}`.trim());
    return id;
  };
  const optedOut = (el: Element, rule: string) => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const rules = (n.getAttribute("data-ouro-allow") ?? "").split(/\s+/);
      if ((rules.includes(rule) || rules.includes("all")) && (n.getAttribute("data-ouro-allow-why") ?? "").trim()) return true;
    }
    return false;
  };
  const describe = (el: Element) => {
    const words = (el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("title") || "").trim().replace(/\s+/g, " ");
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${[...el.classList].slice(0, 3).join(".")}` : ""}${words ? ` "${words.slice(0, 40)}${words.length > 40 ? "…" : ""}"` : ""}`;
  };

  // The theme's tokens, as the page defines them on its root. The radius steps are page variables, or, where a theme maps
  // them inline (shadcn's @theme inline), shadcn's own multiples of --radius.
  const rootStyle = getComputedStyle(document.documentElement);
  const defined = (name: string) => rootStyle.getPropertyValue(name).trim() !== "";
  const colorNames = [
    "background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary", "primary-foreground",
    "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground", "destructive",
    "destructive-foreground", "success", "success-foreground", "warning", "warning-foreground", "border", "input", "ring",
  ];
  const colorTokens = colorNames.filter((name) => defined(`--${name}`));
  const radiusFactors: Record<string, number> = { sm: 0.6, md: 0.8, lg: 1, xl: 1.4, "2xl": 1.8 };
  const radiusTokens = Object.keys(radiusFactors).filter((step) => defined(`--radius-${step}`) || defined("--radius"));
  const shadowTokens = ["xs", "sm", "md", "lg", "xl", "2xl"].filter((step) => defined(`--shadow-${step}`));
  const fontTokens = ["sans", "serif", "mono", "heading"].filter((name) => defined(`--font-${name}`));
  const spacing = defined("--spacing");
  if (!colorTokens.length && !radiusTokens.length && !shadowTokens.length && !fontTokens.length && !spacing) return issues;

  // A probe reads what a value computes to, so a fixed value can be set beside each token.
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:-9999px;top:0;width:10px;height:10px;visibility:hidden;pointer-events:none";
  document.body.append(probe);
  const computed = (property: string, value: string) => {
    // Put back what the probe held, so a value the browser rejects reads the same every time.
    const before = probe.style.getPropertyValue(property);
    probe.style.setProperty(property, value);
    const out = getComputedStyle(probe).getPropertyValue(property);
    probe.style.setProperty(property, before);
    return out;
  };
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const paint = canvas.getContext("2d", { willReadFrequently: true })!;
  const rgb = (color: string) => {
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = "#000";
    paint.fillStyle = color;
    paint.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
    return { r: r!, g: g!, b: b!, a: a! / 255 };
  };
  // A width can't be negative, so a negative length is measured by its size.
  const px = (length: string) => parseFloat(computed("width", length.replace(/^-/, "")));
  const tokenColors = colorTokens.map((name) => ({ name, color: rgb(computed("color", `var(--${name})`)) }));
  const radiusValue = (step: string) =>
    defined(`--radius-${step}`) ? `var(--radius-${step})` : radiusFactors[step] === 1 ? "var(--radius)" : `calc(var(--radius) * ${radiusFactors[step]})`;
  const radiusSteps = radiusTokens.map((step) => ({ step, px: parseFloat(computed("border-top-left-radius", radiusValue(step))) }));
  const spacingPx = spacing ? px("var(--spacing)") : 0;
  const lengths = (value: string) => [...value.matchAll(/(-?\d*\.?\d+(?:e[+-]?\d+)?)(px|rem|em)\b/gi)].map(([, n, unit]) => ({ n: Number(n), unit: unit! }));

  // Colours. Each property takes the tokens that fit what it paints, and the class that sets them: text a foreground, a
  // fill a surface, a border or an outline the line tokens; a fill or stroke in an SVG, an accent or a caret any token.
  const roles: [RegExp, string, string[]][] = [
    [/^color$|^text-|^caret-/, "text", ["foreground", "muted-foreground", "primary", "destructive", "success", "warning", "card-foreground", "popover-foreground", "primary-foreground", "secondary-foreground", "accent-foreground", "destructive-foreground"]],
    [/^background/, "bg", ["card", "background", "popover", "muted", "secondary", "accent", "primary", "destructive", "success", "warning"]],
    [/^border/, "border", ["border", "input", "ring", "primary", "destructive", "foreground", "muted-foreground"]],
    [/^outline/, "outline", ["ring", "border", "primary", "destructive", "foreground"]],
  ];
  // A rule scoped to a theme the run isn't in (.dark) can't be measured against that theme's colours: it takes the
  // role's own token.
  const colorUse = (property: string, value: string, scoped: boolean) => {
    const [, prefix, fitting] = roles.find(([test]) => test.test(property)) ?? [null, "", colorTokens];
    const pool = fitting.flatMap((name) => tokenColors.filter((token) => token.name === name));
    const from = pool.length ? pool : tokenColors;
    const literal = value.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|var\(--color-[a-z]+(?:-\d+)?\)/i)?.[0] ?? value;
    const c = rgb(computed("color", literal));
    const distance = (t: (typeof tokenColors)[number]) => (t.color.r - c.r) ** 2 + (t.color.g - c.g) ** 2 + (t.color.b - c.b) ** 2;
    const best = scoped ? from[0]! : from.reduce((a, b) => (distance(b) < distance(a) ? b : a));
    return prefix ? `var(--${best.name}) (${prefix}-${best.name})` : `var(--${best.name})`;
  };
  const system = new Set(["canvas", "canvastext", "linktext", "visitedtext", "activetext", "buttonface", "buttontext", "buttonborder", "field", "fieldtext", "highlight", "highlighttext", "selecteditem", "selecteditemtext", "mark", "marktext", "graytext", "accentcolor", "accentcolortext"]);
  const palette = /var\(--color-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|mauve|olive|mist|taupe)-\d+\b|var\(--color-(?:white|black)\)/;
  // Hex, a colour function or a colour's name, or Tailwind's palette; a fully see-through colour paints nothing.
  const fixedColor = (value: string) => {
    if (palette.test(value)) return true;
    if (value.includes("var(")) return false;
    const literal = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(value);
    const named = /^[a-z]+$/i.test(value) && !system.has(value.toLowerCase());
    return (literal || named) && rgb(value).a > 0;
  };

  const kinds: {
    kind: string;
    rule: "off-theme" | "off-scale";
    test: (property: string) => boolean;
    on: boolean;
    fixed: (value: string, property: string) => boolean;
    suggest: (value: string, property: string, el: Element, scoped: boolean) => string;
  }[] = [
    {
      kind: "colour",
      rule: "off-theme",
      test: (p) => /(^|-)color$/.test(p) || p === "fill" || p === "stroke" || p === "background-image",
      on: colorTokens.length > 0,
      // A background picture counts only as a gradient, by the colours it names outside the theme's.
      fixed: (v, p) => (p === "background-image" ? /gradient\(/.test(v) && (palette.test(v) || fixedColor(v.replace(/var\([^)]*\)/g, ""))) : fixedColor(v)),
      suggest: (v, p, _el, scoped) => colorUse(p, v, scoped),
    },
    {
      kind: "radius",
      rule: "off-theme",
      test: (p) => /^border-.*radius$/.test(p),
      on: radiusTokens.length > 0,
      // A pill's 9999px or calc(infinity * 1px), and a circle's 50%, are shapes, not steps.
      fixed: (v) => !v.includes("var(") && !/infinity/i.test(v) && lengths(v).some(({ n, unit }) => n !== 0 && !(unit === "px" && n >= 999)),
      suggest: (v) => {
        const want = parseFloat(computed("border-top-left-radius", v.split(/\s+/)[0]!));
        const best = radiusSteps.reduce((a, b) => (Math.abs(b.px - want) < Math.abs(a.px - want) ? b : a));
        return `${radiusValue(best.step)} (rounded-${best.step})`;
      },
    },
    {
      kind: "shadow",
      rule: "off-theme",
      test: (p) => p === "box-shadow",
      on: shadowTokens.length > 0,
      fixed: (v) => !v.includes("var("),
      suggest: () => {
        const step = shadowTokens.includes("md") ? "md" : shadowTokens[0];
        return `one of the theme's shadows, such as var(--shadow-${step}) (shadow-(--shadow-${step}))`;
      },
    },
    {
      kind: "font",
      rule: "off-theme",
      test: (p) => p === "font-family",
      on: fontTokens.length > 0,
      fixed: (v) => !v.includes("var("),
      suggest: (_v, _p, el) => {
        const want = [
          [el.matches("h1, h2, h3, h4, h5, h6"), "heading"],
          [el.matches("code, pre, kbd, samp"), "mono"],
          [true, "sans"],
        ].find(([match, name]) => match && fontTokens.includes(name as string))?.[1] ?? fontTokens[0];
        return `var(--font-${want})`;
      },
    },
    {
      kind: "spacing",
      rule: "off-scale",
      test: (p) => /^(padding|margin)(-|$)/.test(p) || /^(row-|column-)?gap$/.test(p),
      on: spacing,
      // Spacing in em follows the text's size, and clamp(), min(), max() or a viewport unit is fluid: layout choices the
      // spacing scale doesn't make. A length under half a step is a hairline, not a step.
      fixed: (v) =>
        !v.includes("var(") &&
        !/\b(?:clamp|min|max)\(|\d(?:vw|vh|vi|vb|dvh|svh|lvh|cq\w*)\b/.test(v) &&
        lengths(v).some(({ n, unit }) => unit !== "em" && Math.abs(px(`${n}${unit}`)) >= spacingPx / 2),
      suggest: (v, p) => {
        const first = lengths(v).find(({ n, unit }) => unit !== "em" && Math.abs(px(`${n}${unit}`)) >= spacingPx / 2)!;
        const steps = Math.round(Math.abs(px(`${first.n}${first.unit}`)) / spacingPx);
        const prefix = p.startsWith("padding") ? "p" : p.startsWith("margin") ? "m" : "gap";
        return `calc(var(--spacing) * ${steps}) (${prefix}-${steps})`;
      },
    },
  ];
  const keywords = new Set(["transparent", "currentcolor", "inherit", "initial", "unset", "revert", "revert-layer", "none", "auto"]);
  // A property by the family its longhands share, so border-radius or padding is one finding, not four.
  const families: [RegExp, string][] = [
    [/^border-.*radius$/, "border-radius"],
    [/^border-.*color$/, "border-color"],
    [/^background-(?:color|image)$/, "background"],
    [/^padding/, "padding"],
    [/^margin/, "margin"],
    [/gap$/, "gap"],
  ];
  const family = (property: string) => families.find(([test]) => test.test(property))?.[1] ?? property;

  // The page's style rules, each with the layer it is in and the selector that picks its elements.
  const found: { rule: CSSStyleRule | CSSNestedDeclarations; layer: string; selector: string; supports: boolean }[] = [];
  const walk = (list: CSSRuleList, layer: string, outer: string, supports = false) => {
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSLayerBlockRule) walk(rule.cssRules, rule.name.split(".")[0] || layer, outer, supports);
      else if (rule instanceof CSSStyleRule) {
        // A nested rule's selector, resolved against the rule around it: browsers write a nested rule's & in.
        const around = outer.includes(",") ? `:is(${outer})` : outer;
        const selector = outer ? rule.selectorText.replaceAll("&", around) : rule.selectorText;
        found.push({ rule, layer, selector, supports });
        walk(rule.cssRules, layer, selector, supports);
      } else if (rule.constructor.name === "CSSNestedDeclarations") {
        // Declarations nested in a rule's own @supports, which hold the rule's selector.
        found.push({ rule: rule as CSSNestedDeclarations, layer, selector: outer, supports });
      } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule || rule instanceof CSSContainerRule) walk(rule.cssRules, layer, outer, supports || rule instanceof CSSSupportsRule);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      walk(sheet.cssRules, "", "");
    } catch {
      // A stylesheet from another origin can't be read; it isn't the app's own.
    }
  }
  // States and pseudo-elements a selector names but querySelectorAll can't match now, and the theme it is scoped to
  // (.dark, [data-theme], Tailwind's dark variant), which the run may not be in.
  const unscoped = (selector: string) =>
    selector
      .replace(/:(?:where|is)\(\s*\.dark\s*,\s*\.dark\s+\*\s*\)/g, "")
      .replace(/\.dark(?![\w\\-])/g, "")
      .replace(/\[data-theme(?:[~|^$*]?=(?:"[^"]*"|'[^']*'|[^\]]*))?\]/g, "");
  const plain = (selector: string) =>
    unscoped(selector)
      .replace(/::?(?:before|after|placeholder|selection|marker|backdrop|first-line|first-letter|file-selector-button|-webkit-[a-z-]+|-moz-[a-z-]+)(?![\w-])/g, "")
      .replace(/:(?:hover|focus|focus-visible|focus-within|active|visited|target)(?![\w-])/g, "")
      .replace(/^\s*[>+~]\s*/, "");

  // Each custom property's definitions, so a value that goes through a variable of the app's own (--brand: #6d28d9) is
  // judged by what that variable holds. The theme's, Tailwind's and Ouro's own variables are tokens.
  const defs = new Map<string, string[]>();
  for (const { rule } of found) {
    for (let i = 0; i < rule.style.length; i++) {
      const name = rule.style[i]!;
      if (name.startsWith("--")) defs.set(name, [...(defs.get(name) ?? []), rule.style.getPropertyValue(name).trim()]);
    }
  }
  const tokenVar = (name: string) => {
    const bare = name.slice(2);
    // The theme's own names and steps, and Ouro's, Tailwind's and shadcn's own variables; any other name in those
    // namespaces (--shadow-glow, --radius-card, --text-muted) is the app's.
    return (
      colorNames.includes(bare.replace(/^color-/, "")) ||
      /^(?:radius(?:-(?:xs|sm|md|lg|xl|[2-4]xl))?|shadow-(?:2xs|xs|sm|md|lg|xl|2xl)|font-(?:sans|serif|mono|heading)|spacing|text-(?:xs|sm|base|lg|xl|[2-9]xl)(?:--.*)?)$/.test(bare) ||
      /^(?:ouro-|tw-|chart-|sidebar|avatar-|leading-|tracking-|default-|animate-|ease-|blur-|container-|breakpoint-|inset-shadow-|drop-shadow-|perspective-|aspect-)/.test(bare)
    );
  };
  // A variable of the app's own that the theme is built from (--muted: var(--color-undergrowth)) is the theme's too,
  // through any depth of the app's own variables.
  const names = (value: string) => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map(([, name]) => name!);
  const themeVars = new Set<string>();
  const from = [...defs.keys()].filter(tokenVar);
  while (from.length) {
    for (const name of (defs.get(from.pop()!) ?? []).flatMap(names)) {
      if (!tokenVar(name) && !themeVars.has(name)) {
        themeVars.add(name);
        from.push(name);
      }
    }
  }
  // The colours the theme's tokens are given, in each theme, by value: a variable of the app's own that holds one of
  // them, or a whole spacing step, or one of the radius steps, names the theme's value rather than bypassing it.
  const themeColors = new Set(
    [...defs.entries()]
      .filter(([name]) => tokenVar(name) && colorNames.includes(name.slice(2).replace(/^color-/, "")))
      .flatMap(([, values]) => values)
      .filter((v) => !v.includes("var(") && fixedColor(v))
      .map((v) => JSON.stringify(rgb(v))),
  );
  const onTheme = (kind: string, value: string) => {
    if (kind === "colour") return !palette.test(value) && themeColors.has(JSON.stringify(rgb(value)));
    const all = lengths(value).filter(({ n }) => n !== 0);
    if (value.includes("(")) return false;
    if (kind === "spacing") return all.every(({ n, unit }) => unit !== "em" && Number.isInteger(Math.round((px(`${n}${unit}`) / spacingPx) * 1000) / 1000));
    if (kind === "radius") return all.every(({ n, unit }) => radiusSteps.some((step) => Math.abs(step.px - px(`${n}${unit}`)) < 0.5));
    return false;
  };
  // The fixed value a variable of the app's own holds, through other variables of its own, or "".
  const throughOwn = (value: string, test: (v: string) => boolean, depth = 0): string => {
    for (const name of names(value)) {
      if (depth >= 4 || tokenVar(name) || themeVars.has(name)) continue;
      for (const d of defs.get(name) ?? []) {
        const held = test(d) ? d : throughOwn(d, test, depth + 1);
        if (held) return held;
      }
    }
    return "";
  };

  // A rule that sets a property through a variable and also to a fixed fallback for older browsers (Tailwind's
  // bg-canopy/30 writes the colour itself, then color-mix() of var(--color-canopy) under @supports) is judged by the
  // variable: the fallback is the token compiled.
  const throughVar = new Set<string>();
  for (const { rule, selector } of found.filter((f) => f.supports)) {
    for (let i = 0; i < rule.style.length; i++) {
      const property = rule.style[i]!;
      if (!property.startsWith("--") && rule.style.getPropertyValue(property).includes("var(")) throughVar.add(`${selector}\u0000${family(property)}`);
    }
  }

  const seen = new Set<string>();
  try {
    for (const { rule, layer, selector } of found) {
      if (layer === "theme" || layer === "base") continue;
      for (let i = 0; i < rule.style.length && issues.length < maxIssues; i++) {
        const property = rule.style[i]!;
        // A longhand of a shorthand written with a variable reads empty until the variable is substituted: the
        // shorthand holds the value.
        const value = [property, family(property), property.split("-")[0]!].map((name) => rule.style.getPropertyValue(name).trim()).find(Boolean) ?? "";
        // A custom property defines a token rather than using one, but a utility that puts Tailwind's palette in one
        // (a gradient's stops, a ring's colour) sets that colour.
        const kind = property.startsWith("--")
          ? layer === "utilities" && property.startsWith("--tw-") && palette.test(value) ? kinds.find((k) => k.on && k.kind === "colour") : undefined
          : kinds.find((k) => k.on && k.test(property));
        if (!kind || !value || keywords.has(value.toLowerCase())) continue;
        const ownFixed = (d: string) => !keywords.has(d.toLowerCase()) && (kind.kind === "colour" ? fixedColor(d) : kind.fixed(d, property)) && !onTheme(kind.kind, d);
        // What is measured for the token to name: the value, or what the app's own variable holds.
        const key = `${selector}\u0000${family(property)}`;
        const fallback = !value.includes("var(") && throughVar.has(key);
        const held = fallback ? "" : kind.fixed(value, property) ? value : throughOwn(value, ownFixed);
        if (!held) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        let elements: Element[];
        try {
          elements = [...document.querySelectorAll(plain(selector) || "*")];
        } catch {
          continue;
        }
        // A utility on an Ouro component's own element is the component's; a drawing's fills are its picture's.
        const el = elements.find(
          (e) => e !== probe && !(layer === "utilities" && e.closest("[data-ouro]")) && !(kind.kind === "colour" && e.closest("svg")) && !optedOut(e, kind.rule),
        );
        if (!el) continue;
        issues.push({
          ref: ref(el),
          rule: kind.rule,
          element: describe(el),
          // The shorthand's value where the rule has one, as it was written.
          detail: `${selector} sets ${family(property)}: ${rule.style.getPropertyValue(family(property)).trim() || value}, a fixed ${kind.kind}; use ${kind.suggest(held, property, el, unscoped(selector) !== selector)}`,
        });
      }
    }
  } finally {
    probe.remove();
  }
  return issues;
}
