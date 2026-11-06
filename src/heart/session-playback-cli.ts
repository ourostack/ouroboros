import { formatPlaybackReport, runSessionPlayback } from "./session-playback"

function printHelp(): void {
  // eslint-disable-next-line no-console -- meta-tooling
  console.log([
    "usage: ouro session-playback <session.json> [--json]",
    "",
    "Loads a saved session.json, runs it through the same sanitize pipeline that fires before",
    "every replay, and prints a report of what would be dropped, content-modified, or",
    "synthetically inserted. Read-only; the file on disk is never written.",
    "",
    "Useful when an agent is stuck in a replay loop and you want to see what the harness",
    "thinks is wrong with the session before deciding whether to clear or repair.",
  ].join("\n"))
}

export function runSessionPlaybackCli(argv: string[]): number {
  const positional = argv.filter((token) => !token.startsWith("--"))
  const flags = new Set(argv.filter((token) => token.startsWith("--")))

  if (flags.has("--help") || flags.has("-h") || positional.length === 0) {
    printHelp()
    return positional.length === 0 ? 2 : 0
  }
  const sessionPath = positional[0]!
  const report = runSessionPlayback({ sessionPath })
  if (flags.has("--json")) {
    // eslint-disable-next-line no-console -- meta-tooling
    console.log(JSON.stringify(report, null, 2))
  } else {
    // eslint-disable-next-line no-console -- meta-tooling
    console.log(formatPlaybackReport(report))
  }
  return 0
}
