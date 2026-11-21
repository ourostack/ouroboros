// The parser the ts-parser walker covers.
export function parse(args: string[]): { kind: string } {
  return { kind: args[0] ?? "up" }
}
