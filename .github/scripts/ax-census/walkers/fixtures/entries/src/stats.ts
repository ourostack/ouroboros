// The runner an entry point calls; its literal comparisons are the entry's subcommands.
export function runStats([sub, ...rest]: string[]): number {
  if (sub === "summary") return 0
  if (sub === "export" && rest.includes("--json")) return 0
  return 2
}

export function noStats(): Error {
  return Object.assign(new Error("no sessions yet"), { code: "no-stats" })
}
