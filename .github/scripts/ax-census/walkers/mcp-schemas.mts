// The mcp-serve walker: the doors are exactly what the built server's getToolSchemas() returns, and each door's line
// comes from its `name: "<literal>"` in the TypeScript source, found in the syntax tree (never a regex over text).
// A name with no literal in source is still a door, with `line: null`. Read-only evidence is the served
// `readOnlyHint`: from `listTools()` when the module exports it (what tools/list answers), else on the schema. Every other string literal outside a card (an
// `ax` property or the `serverErrors` declaration) is a code the handler may raise: a card's error code counts as
// raised only when one of these matches it. A server that declares any tool card must export `serverErrors` with an
// `unknown-door` card, the answer to a tool name it doesn't have, and raise that code too.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import type { Door, DoorCard, WalkerOptions, WalkResult } from "../types.mts";

const isText = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

/** A node that holds a card: an `ax: ...` property, or the `serverErrors` declaration. Its literals are declarations, not raises. */
function isCard(node: ts.Node): boolean {
  if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) return node.name.text === "ax";
  return ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "serverErrors";
}

/**
 * Every `name: "<literal>"` in an object literal that also has `inputSchema`, as 1-based lines per name, in source
 * order, and every string literal outside a card.
 */
function readSource(fileName: string, text: string): { lines: Map<string, number[]>; literals: Set<string> } {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lines = new Map<string, number[]>();
  const literals = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (isCard(node)) return;
    if (isText(node)) literals.add(node.text);
    if (ts.isObjectLiteralExpression(node)) {
      const named = (p: ts.ObjectLiteralElementLike, key: string) => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === key;
      const name = node.properties.find((p) => named(p, "name"));
      if (name && ts.isPropertyAssignment(name) && node.properties.some((p) => named(p, "inputSchema") || (ts.isShorthandPropertyAssignment(p) && p.name.text === "inputSchema"))) {
        const init = name.initializer;
        if (isText(init)) {
          const line = sourceFile.getLineAndCharacterOfPosition(name.getStart(sourceFile)).line + 1;
          lines.set(init.text, [...(lines.get(init.text) ?? []), line]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { lines, literals };
}

interface Schema {
  name?: unknown;
  description?: unknown;
  annotations?: { readOnlyHint?: unknown };
  ax?: DoorCard;
}

export async function walkMcpSchemas(opts: WalkerOptions): Promise<WalkResult> {
  const sourcePath = resolve(opts.root, opts.source);
  const file = relative(opts.root, sourcePath);
  const require = createRequire(join(opts.root, "package.json"));
  const loaded = require(resolve(opts.root, opts.module)) as { getToolSchemas?: unknown; listTools?: unknown; serverErrors?: unknown };
  if (typeof loaded.getToolSchemas !== "function") {
    return { doors: [], errors: [`${opts.module}: exports no getToolSchemas function`] };
  }
  const schemas = (loaded.getToolSchemas as () => Schema[])();
  // A server that serves a projection of its schemas (`listTools()`, what tools/list answers) has its annotations there.
  const served = new Map((typeof loaded.listTools === "function" ? (loaded.listTools as () => Schema[])() : []).map((t) => [t.name, t]));
  const { lines, literals } = readSource(sourcePath, await readFile(sourcePath, "utf8"));
  const doors: Door[] = [];
  const errors: string[] = [];
  const seen = new Map<string, number>();
  for (const schema of schemas) {
    if (typeof schema.name !== "string" || schema.name.length === 0) {
      errors.push(`${opts.module}: getToolSchemas returned a tool without a name`);
      continue;
    }
    const name = schema.name;
    const id = `mcp:${name}`;
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    const found = lines.get(name) ?? [];
    if (count === 2) {
      const at = found.length > 0 ? found.map((l) => `${file}:${l}`).join(" and ") : `${file}, with no literal name`;
      errors.push(`${id}: listed twice, at ${at}`);
    }
    if (count > 1) continue;
    doors.push({
      id,
      kind: "mcp",
      product: opts.product,
      name,
      description: typeof schema.description === "string" ? schema.description : "",
      file,
      line: found[0] ?? null,
      card: schema.ax ?? null,
      evidence: {
        ...((served.get(name) ?? schema).annotations?.readOnlyHint === true ? { readOnly: true } : {}),
        ...(Array.isArray(schema.ax?.errors) ? { raises: schema.ax.errors.map((e) => e?.code).filter((code) => literals.has(code)) } : {}),
      },
    });
  }
  if (doors.some((d) => d.card)) {
    const cards = Array.isArray(loaded.serverErrors) ? (loaded.serverErrors as { code?: unknown }[]) : [];
    if (!cards.some((c) => c?.code === "unknown-door")) {
      errors.push(`${opts.module}: declares tool cards but exports no serverErrors with an unknown-door card, the answer to an unknown tool name`);
    } else if (!literals.has("unknown-door")) {
      errors.push(`${opts.module}: the unknown-door code is never raised in ${file}`);
    }
  }
  return { doors, errors };
}
