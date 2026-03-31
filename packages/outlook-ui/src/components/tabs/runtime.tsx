import { useEffect, useState } from "react"
import { Badge } from "../../catalyst/badge"
import { fetchJson, relTime } from "../../api"

export function RuntimeTab({ agentName, view }: { agentName: string; view: Record<string, unknown> }) {
  const [health, setHealth] = useState<Record<string, unknown> | null>(null)
  const [logs, setLogs] = useState<Record<string, unknown> | null>(null)

  const agent = view.agent as Record<string, unknown>
  const degraded = agent.degraded as { status: string; issues: Array<{ code: string; detail: string }> }
  const freshness = agent.freshness as { status: string; ageMs: number | null }

  useEffect(() => {
    Promise.all([
      fetchJson<Record<string, unknown>>("/machine/health").then(setHealth).catch(() => null),
      fetchJson<Record<string, unknown>>("/machine/logs").then(setLogs).catch(() => null),
    ])
  }, [agentName])

  const degradedComponents = (health?.degradedComponents ?? []) as Array<Record<string, unknown>>
  const logEntries = (logs?.entries ?? []) as Array<Record<string, unknown>>

  return (
    <div className="space-y-8">
      {/* Agent issues — the actual degraded state */}
      {degraded.status === "degraded" && degraded.issues.length > 0 && (
        <section>
          <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-ouro-fang">
            Agent issues ({degraded.issues.length})
          </p>
          <div className="mt-3 space-y-1.5">
            {degraded.issues.map((issue, i) => (
              <div key={i} className="rounded-lg bg-ouro-fang/5 px-3 py-2.5 ring-1 ring-ouro-fang/15">
                <p className="font-mono text-xs font-semibold text-ouro-fang">{issue.code}</p>
                <p className="mt-0.5 text-xs text-ouro-mist break-all">{issue.detail}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Agent config */}
      <section>
        <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-ouro-glow">Agent config</p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Fact label="Provider" value={(agent.provider as string) || "none"} />
          <Fact label="Enabled" value={agent.enabled ? "yes" : "no"} />
          <Fact label="Freshness" value={`${freshness.status}${freshness.ageMs != null ? ` (${Math.floor(freshness.ageMs / 60000)}m)` : ""}`} />
        </div>
      </section>

      {/* Daemon health */}
      <section>
        <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-ouro-glow">Daemon health</p>
        {health && (health.status as string) !== "unavailable" ? (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Fact label="Status" value={health.status as string} />
              <Fact label="Mode" value={health.mode as string} />
              <Fact label="Uptime" value={`${Math.floor((health.uptimeSeconds as number) / 60)}m`} />
            </div>
            {degradedComponents.length > 0 && (
              <div className="mt-3 space-y-1.5">
                <p className="font-mono text-[10px] uppercase tracking-wider text-ouro-fang">Degraded components</p>
                {degradedComponents.map((d, i) => (
                  <div key={i} className="rounded-lg bg-ouro-fang/5 px-3 py-2 ring-1 ring-ouro-fang/15">
                    <p className="text-xs font-semibold text-ouro-fang">{d.component as string}</p>
                    <p className="text-xs text-ouro-mist">{d.reason as string}</p>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <p className="mt-2 text-sm text-ouro-shadow">
            No health file found. This is normal when not running under the daemon.
          </p>
        )}
      </section>

      {/* Logs */}
      <section>
        <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-ouro-glow">
          Recent logs ({(logs?.totalLines as number) ?? 0} total)
        </p>
        {logEntries.length > 0 ? (
          <div className="mt-3 max-h-96 overflow-y-auto rounded-lg bg-ouro-void/40 ring-1 ring-ouro-moss/15">
            {[...logEntries].reverse().slice(0, 50).map((e, i) => {
              const level = e.level as string
              return (
                <div key={i} className="border-b border-ouro-moss/10 px-3 py-1.5 last:border-b-0">
                  <div className="flex items-center gap-2 text-xs">
                    <Badge color={level === "error" ? "red" : level === "warn" ? "yellow" : "zinc"}>{level}</Badge>
                    <span className="text-ouro-shadow">{relTime(e.ts as string)}</span>
                    <span className="font-mono text-ouro-glow">{e.event as string}</span>
                  </div>
                  <p className="truncate text-xs text-ouro-mist">{e.message as string}</p>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="mt-2 text-sm text-ouro-shadow">No log entries.</p>
        )}
      </section>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-ouro-void/40 px-3 py-2.5 ring-1 ring-ouro-moss/15">
      <p className="font-mono text-[10px] uppercase tracking-wider text-ouro-shadow">{label}</p>
      <p className="mt-1 text-sm font-medium text-ouro-bone">{value}</p>
    </div>
  )
}
