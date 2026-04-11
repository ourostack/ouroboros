import { useEffect, useState } from "react"
import { Badge } from "../../catalyst/badge"
import { fetchJson, relTime } from "../../api"
import type { OutlookAgentView, OutlookDaemonHealthDeep, OutlookLogView } from "../../contracts"

type MachineHealthResponse = OutlookDaemonHealthDeep | { status: "unavailable" }

export function RuntimeTab({ agentName, view, refreshGeneration }: { agentName: string; view: OutlookAgentView; refreshGeneration: number }) {
  const [health, setHealth] = useState<MachineHealthResponse | null>(null)
  const [logs, setLogs] = useState<OutlookLogView | null>(null)

  const agent = view.agent
  const degraded = agent.degraded
  const freshness = agent.freshness

  useEffect(() => {
    Promise.all([
      fetchJson<MachineHealthResponse>("/machine/health").then(setHealth).catch(() => null),
      fetchJson<OutlookLogView>("/machine/logs").then(setLogs).catch(() => null),
    ])
  }, [agentName, refreshGeneration])

  const machineHealth = isMachineHealthAvailable(health) ? health : null
  const degradedComponents = machineHealth?.degradedComponents ?? []
  const logEntries = logs?.entries ?? []

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
          <Fact label="Provider" value={agent.provider || "none"} />
          <Fact label="Enabled" value={agent.enabled ? "yes" : "no"} />
          <Fact label="Freshness" value={`${freshness.status}${freshness.ageMs != null ? ` (${Math.floor(freshness.ageMs / 60000)}m)` : ""}`} />
        </div>
      </section>

      {/* Daemon health */}
      <section>
        <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-ouro-glow">Daemon health</p>
        {machineHealth ? (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Fact label="Status" value={machineHealth.status} />
              <Fact label="Mode" value={machineHealth.mode} />
              <Fact label="Uptime" value={`${Math.floor(machineHealth.uptimeSeconds / 60)}m`} />
            </div>
            {degradedComponents.length > 0 && (
              <div className="mt-3 space-y-1.5">
                <p className="font-mono text-[10px] uppercase tracking-wider text-ouro-fang">Degraded components</p>
                {degradedComponents.map((d, i) => (
                  <div key={i} className="rounded-lg bg-ouro-fang/5 px-3 py-2 ring-1 ring-ouro-fang/15">
                    <p className="text-xs font-semibold text-ouro-fang">{d.component}</p>
                    <p className="text-xs text-ouro-mist">{d.reason}</p>
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
          Recent logs ({logs?.totalLines ?? 0} total)
        </p>
        {logEntries.length > 0 ? (
          <div className="mt-3 max-h-96 overflow-y-auto rounded-lg bg-ouro-void/40 ring-1 ring-ouro-moss/15">
            {[...logEntries].reverse().slice(0, 50).map((e, i) => {
              const level = e.level
              return (
                <div key={i} className="border-b border-ouro-moss/10 px-3 py-1.5 last:border-b-0">
                  <div className="flex items-center gap-2 text-xs">
                    <Badge color={level === "error" ? "red" : level === "warn" ? "yellow" : "zinc"}>{level}</Badge>
                    <span className="text-ouro-shadow">{relTime(e.ts)}</span>
                    <span className="font-mono text-ouro-glow">{e.event}</span>
                  </div>
                  <p className="truncate text-xs text-ouro-mist">{e.message}</p>
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

function isMachineHealthAvailable(health: MachineHealthResponse | null): health is OutlookDaemonHealthDeep {
  return Boolean(health && "degradedComponents" in health)
}
