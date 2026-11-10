import { emitNervesEvent } from "../nerves/runtime"
import { serveProviderPingChild } from "./provider-ping-child"

/* v8 ignore start -- process entry: serveProviderPingChild is unit-tested, and the edge benchmark runs this end to end @preserve */
emitNervesEvent({ component: "engine", event: "engine.provider_ping_child_start", message: "provider ping child started", meta: {} })
void serveProviderPingChild(process.stdin, (text) => { process.stdout.write(text) }).then((code) => { process.exitCode = code })
/* v8 ignore stop */
