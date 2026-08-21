#!/usr/bin/env node
import {
  createSanctuaryHealthAcceptanceProbeCliOutput,
  startSanctuaryHealthAcceptanceProbeCli,
} from "./sanctuary-health-acceptance-probe"
import { emitNervesEvent } from "../nerves/runtime"

emitNervesEvent({
  component: "senses",
  event: "senses.entry_boot",
  message: "booting Sanctuary health acceptance probe entrypoint",
  meta: { entry: "sanctuary-health-acceptance-probe" },
})

startSanctuaryHealthAcceptanceProbeCli(process.argv.slice(2), createSanctuaryHealthAcceptanceProbeCliOutput())
