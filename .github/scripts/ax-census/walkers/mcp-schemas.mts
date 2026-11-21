// The mcp-serve walker: the doors are exactly what the built server's getToolSchemas() returns, and each door's line
// comes from its `name: "<literal>"` in the TypeScript source, found in the syntax tree (never a regex over text).
// A name with no literal in source is still a door, with `line: null`.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import type { Door, DoorCard, WalkerOptions, WalkResult } from "../types.mts";

/** Every `name: "<literal>"` in an object literal that also has `inputSchema`, as 1-based lines per name, in source order. */
function literalLines(fileName: string, text: string): Map<string, number[]> {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lines = new Map<string, number[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const named = (p: ts.ObjectLiteralElementLike, key: string) => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === key;
      const name = node.properties.find((p) => named(p, "name"));
      if (name && ts.isPropertyAssignment(name) && node.properties.some((p) => named(p, "inputSchema") || (ts.isShorthandPropertyAssignment(p) && p.name.text === "inputSchema"))) {
        const init = name.initializer;
        if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
          const line = sourceFile.getLineAndCharacterOfPosition(name.getStart(sourceFile)).line + 1;
          lines.set(init.text, [...(lines.get(init.text) ?? []), line]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
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
  const loaded = require(resolve(opts.root, opts.module)) as { getToolSchemas?: unknown };
  if (typeof loaded.getToolSchemas !== "function") {
    return { doors: [], errors: [`${opts.module}: exports no getToolSchemas function`] };
  }
  const schemas = (loaded.getToolSchemas as () => Schema[])();
  const lines = literalLines(sourcePath, await readFile(sourcePath, "utf8"));
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
      evidence: schema.annotations?.readOnlyHint === true ? { readOnly: true } : {},
    });
  }
  return { doors, errors };
}
