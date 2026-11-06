import * as path from "node:path"
import { getAgentDaemonLogsDir } from "../../heart/identity"
import { formatNerveEntry, parseDuration, reviewNerveEvents } from "./core"

interface ParsedArgs {
  process: string
  agent?: string
  componentSubstring?: string
  eventSubstring?: string
  level?: string
  since?: string
  limit?: number
  json: boolean
  help: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { process: "daemon", json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    const next = argv[i + 1]
    switch (token) {
      case "--help":
      case "-h":
        args.help = true
        break
      case "--process":
        if (next) args.process = next
        i++
        break
      case "--agent":
        if (next) args.agent = next
        i++
        break
      case "--component":
        if (next) args.componentSubstring = next
        i++
        break
      case "--event":
        if (next) args.eventSubstring = next
        i++
        break
      case "--level":
        if (next) args.level = next
        i++
        break
      case "--since":
        if (next) args.since = next
        i++
        break
      case "--limit":
        if (next) {
          const parsed = Number.parseInt(next, 10)
          if (Number.isFinite(parsed) && parsed > 0) args.limit = parsed
        }
        i++
        break
      case "--json":
        args.json = true
        break
    }
  }
  return args
}

function printHelp(): void {
  // eslint-disable-next-line no-console -- meta-tooling
  console.log([
    "usage: ouro nerves-review [options]",
    "",
    "Tail the agent's nerves ndjson and filter recent events. Read-only.",
    "",
    "options:",
    "  --process <name>      log stream to read (default: daemon)",
    "  --agent <name>        agent bundle to read from (default: current)",
    "  --component <substr>  filter by component substring (case-insensitive)",
    "  --event <substr>      filter by event-name substring (case-insensitive)",
    "  --level <level>       filter by exact level (debug|info|warn|error)",
    "  --since <duration>    only events newer than e.g. 5m, 2h, 1d",
    "  --limit <N>           cap returned events (default: 50)",
    "  --json                output one JSON object per line",
  ].join("\n"))
}

export function runNervesReviewCli(argv: string[]): number {
  const args = parseArgs(argv)
  if (args.help) {
    printHelp()
    return 0
  }

  let sinceMs: number | undefined
  if (args.since) {
    const parsed = parseDuration(args.since)
    if (parsed === null) {
      // eslint-disable-next-line no-console -- meta-tooling
      console.error(`nerves-review: --since '${args.since}' is not a valid duration (e.g. 5m, 2h, 1d)`)
      return 2
    }
    sinceMs = parsed
  }

  const logsDir = getAgentDaemonLogsDir(args.agent)
  const filePath = path.join(logsDir, `${args.process}.ndjson`)

  const filter = {
    componentSubstring: args.componentSubstring,
    eventSubstring: args.eventSubstring,
    level: args.level,
    sinceMs,
    limit: args.limit,
    nowMs: Date.now(),
  }
  const entries = reviewNerveEvents(filePath, filter)

  if (entries.length === 0) {
    // eslint-disable-next-line no-console -- meta-tooling
    console.log(`(no matching nerves events in ${filePath})`)
    return 0
  }
  for (const entry of entries) {
    if (args.json) {
      // eslint-disable-next-line no-console -- meta-tooling
      console.log(entry.raw)
    } else {
      // eslint-disable-next-line no-console -- meta-tooling
      console.log(formatNerveEntry(entry))
    }
  }
  return 0
}
