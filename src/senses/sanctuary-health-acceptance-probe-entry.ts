#!/usr/bin/env node
import {
  createSanctuaryHealthAcceptanceProbeCliOutput,
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
// No mode at all: say so before the probe starts. Anything else is the probe's to refuse.
const MISSING_MODE = "missing-mode"
if (argv.length === 0) {
  process.stderr.write(`${SANCTUARY_HEALTH_ACCEPTANCE_PROBE_USAGE}\ncode: ${MISSING_MODE}\n`)
  process.exitCode = 1
} else {
  startSanctuaryHealthAcceptanceProbeCli(argv, createSanctuaryHealthAcceptanceProbeCliOutput())
}
