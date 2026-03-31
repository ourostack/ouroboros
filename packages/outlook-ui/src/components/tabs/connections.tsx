import { useEffect, useState } from "react"
import { Badge } from "../../catalyst/badge"
import { fetchJson, relTime, truncate } from "../../api"
import { useNavigate } from "../../navigation"

export function ConnectionsTab({ agentName, focus, onFocusConsumed }: { agentName: string; focus?: string; onFocusConsumed?: () => void }) {
  const nav = useNavigate()
  const [attention, setAttention] = useState<Record<string, unknown> | null>(null)
  const [bridges, setBridges] = useState<Record<string, unknown> | null>(null)
  const [friends, setFriends] = useState<Record<string, unknown> | null>(null)

  useEffect(() => {
    const base = `/agents/${encodeURIComponent(agentName)}`
    Promise.all([
      fetchJson<Record<string, unknown>>(`${base}/attention`).then(setAttention),
      fetchJson<Record<string, unknown>>(`${base}/bridges`).then(setBridges),
      fetchJson<Record<string, unknown>>(`${base}/friends`).then(setFriends),
    ])
  }, [agentName])

  const queueItems = (attention?.queueItems ?? []) as Array<Record<string, unknown>>
  const bridgeItems = (bridges?.items ?? []) as Array<Record<string, unknown>>
  const friendItems = (friends?.friends ?? []) as Array<Record<string, unknown>>

  return (
    <div className="space-y-8">
      {/* Attention queue — who is waiting on me? */}
      <section>
        <SH label={`Who is waiting (${attention?.queueLength ?? 0})`} />
        {queueItems.length > 0 ? (
          <div className="mt-3 space-y-2">
            {queueItems.map((item, i) => (
              <div key={i} className="rounded-lg bg-ouro-void/40 px-3 py-3 ring-1 ring-ouro-moss/15">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => nav({ tab: "sessions" })}
                    className="font-medium text-ouro-bone hover:text-ouro-glow transition-colors"
                  >
                    {item.friendName as string}
                  </button>
                  <span className="text-xs text-ouro-shadow">via {item.channel as string}</span>
                  <Badge color="yellow">waiting {relTime(new Date(item.timestamp as number).toISOString())}</Badge>
                </div>
                <p className="mt-1 text-sm text-ouro-mist">{truncate(item.delegatedContent as string, 140)}</p>
                <div className="mt-1.5 flex flex-wrap gap-2 text-xs">
                  {item.bridgeId && (
                    <button onClick={() => nav({ tab: "connections", focus: item.bridgeId as string })} className="text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2 hover:decoration-ouro-glow">
                      bridge: {(item.bridgeId as string).slice(0, 12)}…
                    </button>
                  )}
                  {item.obligationId && (
                    <button onClick={() => nav({ tab: "work", focus: item.obligationId as string })} className="text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2 hover:decoration-ouro-glow">
                      obligation: {(item.obligationId as string).slice(0, 16)}…
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-ouro-shadow">Nobody waiting.</p>
        )}
      </section>

      {/* Bridges — "why should I care?" visible in 2 seconds */}
      <section>
        <SH label={`Bridges (${bridges?.totalCount ?? 0})`} />
        {bridgeItems.length > 0 ? (
          <div className="mt-3 space-y-3">
            {bridgeItems.map((b) => {
              const sessions = (b.attachedSessions ?? []) as Array<Record<string, unknown>>
              const task = b.task as Record<string, unknown> | null
              const isActive = (b.lifecycle as string) === "active"

              return (
                <div key={b.id as string} className={`rounded-lg px-3 py-3 ring-1 ${
                  isActive ? "bg-ouro-moss/10 ring-ouro-glow/12" : "bg-ouro-void/40 ring-ouro-moss/15"
                }`}>
                  {/* Line 1: lifecycle + objective (the "why should I care" sentence) */}
                  <div className="flex items-start gap-2">
                    <Badge color={isActive ? "lime" : "zinc"}>{b.lifecycle as string}</Badge>
                    <p className="font-medium text-ouro-bone">{b.objective as string}</p>
                  </div>

                  {/* Line 2: summary — the short explanation */}
                  {(b.summary as string) && (
                    <p className="mt-1 text-sm text-ouro-mist">{truncate(b.summary as string, 160)}</p>
                  )}

                  {/* Attached sessions — clickable, shows who's involved */}
                  {sessions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {sessions.map((s, i) => (
                        <button
                          key={i}
                          onClick={() => nav({ tab: "sessions", focus: `${s.friendId as string}/${s.channel as string}/${s.key as string}` })}
                          className="rounded-md bg-ouro-moss/10 px-2 py-0.5 font-mono text-[11px] text-ouro-glow ring-1 ring-ouro-moss/12 hover:ring-ouro-glow/25 transition-colors"
                        >
                          {s.friendId as string}/{s.channel as string}/{s.key as string}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Linked task */}
                  {task && (
                    <p className="mt-1.5 text-xs">
                      <button onClick={() => nav({ tab: "work" })} className="text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2 hover:decoration-ouro-glow">
                        task: {task.taskName as string}
                      </button>
                      <span className="text-ouro-shadow"> ({task.mode as string})</span>
                    </p>
                  )}

                  <p className="mt-1 text-xs text-ouro-shadow">{relTime(b.updatedAt as string)}</p>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="mt-2 text-sm text-ouro-shadow">No bridges.</p>
        )}
      </section>

      {/* Friends */}
      <section>
        <SH label={`Friends (${friends?.totalFriends ?? 0})`} />
        {friendItems.length > 0 ? (
          <div className="mt-3 space-y-1.5">
            {friendItems.map((f) => (
              <div key={f.friendId as string} className="flex items-center justify-between rounded-lg bg-ouro-void/40 px-3 py-2.5 ring-1 ring-ouro-moss/15">
                <div className="min-w-0">
                  <button onClick={() => nav({ tab: "sessions" })} className="font-medium text-ouro-bone hover:text-ouro-glow transition-colors">
                    {f.friendName as string}
                  </button>
                  <p className="text-xs text-ouro-shadow">
                    {(f.channels as string[]).join(", ")} · {f.sessionCount as number} sessions
                    {f.lastActivityAt && <> · {relTime(f.lastActivityAt as string)}</>}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="tabular-nums text-sm font-medium text-ouro-bone">{(f.totalTokens as number).toLocaleString()}</p>
                  <p className="text-[10px] text-ouro-shadow">tokens</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-ouro-shadow">No friends.</p>
        )}
      </section>
    </div>
  )
}

function SH({ label }: { label: string }) {
  return <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-ouro-glow">{label}</p>
}
