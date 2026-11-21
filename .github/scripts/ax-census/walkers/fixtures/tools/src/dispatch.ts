// The dispatcher raises these for every tool.
export function refuse(reason: string) {
  return reason === "args" ? "invalid-arguments" : "unknown-tool"
}
