// Which string literals in a source file are codes the code may raise: every literal outside a card. Shared by the
// walkers that check a card's error codes against its handler (design section 3).
import ts from "typescript";

const keyOf = (p: ts.ObjectLiteralElementLike): string | null =>
  (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;

/**
 * A node that holds a card: an `ax: ...` property, the `serverErrors` declaration, or an error card wherever it is
 * built (an object literal with `code`, `means` and `fix`, such as one a helper returns). Its literals are
 * declarations, not raises.
 */
export function isCard(node: ts.Node): boolean {
  if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) return node.name.text === "ax";
  if (ts.isObjectLiteralExpression(node)) {
    const keys = new Set(node.properties.map(keyOf));
    return keys.has("code") && keys.has("means") && keys.has("fix");
  }
  return ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "serverErrors";
}

/** Every string literal in the file outside a card. */
export function literalsOutsideCards(sf: ts.SourceFile): Set<string> {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (isCard(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}
