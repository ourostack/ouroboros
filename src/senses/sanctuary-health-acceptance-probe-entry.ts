#!/usr/bin/env node
import {
  createSanctuaryHealthAcceptanceProbeCliOutput,
  isSanctuaryHealthAcceptanceProbeMode,
  SANCTUARY_HEALTH_ACCEPTANCE_PROBE_USAGE,
  startSanctuaryHealthAcceptanceProbeCli,
} from "./sanctuary-health-acceptance-probe"
import { emitNervesEvent } from "../nerves/runtime"

emitNervesEvent({
  component: "senses",
  event: "senses.entry_boot",
  message: "booting Sanctuary health acceptance probe entrypoint",
  meta: { entry: "sanctuary-health-acceptance-probe" },
})

const argv = process.argv.slice(2)
// No step, or a word that isn't one: say so before the probe starts. A step's coordinates are the probe's to refuse.
if (!isSanctuaryHealthAcceptanceProbeMode(argv[0])) {
  const code = argv.length === 0 ? "missing-mode" : "usage"
  process.stderr.write(`${SANCTUARY_HEALTH_ACCEPTANCE_PROBE_USAGE}\ncode: ${code}\n`)
  process.exitCode = 1
} else {
  startSanctuaryHealthAcceptanceProbeCli(argv, createSanctuaryHealthAcceptanceProbeCliOutput())
}
