// Not an entry point: it reads process.argv only when someone calls it.
export function agentName(): string | undefined {
  const at = process.argv.indexOf("--agent")
  return at === -1 ? undefined : process.argv[at + 1]
}
