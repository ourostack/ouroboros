import { useEffect, useState } from "react"
import { Badge } from "../../catalyst/badge"
import { fetchJson, relTime, truncate } from "../../api"
import { useNavigate } from "../../navigation"
import type { MailboxAttentionView, MailboxBridgeInventory, MailboxFriendView } from "../../contracts"

export function ConnectionsTab({ agentName, focus, onFocusConsumed, refreshGeneration }: { agentName: string; focus?: string; onFocusConsumed?: () => void; refreshGeneration: number }) {
  const nav = useNavigate()
  const [attention, setAttention] = useState<MailboxAttentionView | null>(null)
  const [bridges, setBridges] = useState<MailboxBridgeInventory | null>(null)
  const [friends, setFriends] = useState<MailboxFriendView | null>(null)

  useEffect(() => {
    const base = `/agents/${encodeURIComponent(agentName)}`
    Promise.all([
      fetchJson<MailboxAttentionView>(`${base}/attention`).then(setAttention),
      fetchJson<MailboxBridgeInventory>(`${base}/bridges`).then(setBridges),
      fetchJson<MailboxFriendView>(`${base}/friends`).then(setFriends),
    ])
  }, [agentName, refreshGeneration])

  const queueItems = attention?.queueItems ?? []
  const bridgeItems = bridges?.items ?? []
  const friendItems = friends?.friends ?? []

  return (
    <div className="space-y-8">
      {/* Attention queue — who is waiting on me? */}
      <section>
        <SH label={`Who is waiting (${attention?.queueLength ?? 0})`} />
        {queueItems.length > 0 ? (
          <div className="mt-3 space-y-2">
            {queueItems.map((item, i) => {
              const bridgeId = item.bridgeId
              const obligationId = item.obligationId

              return (
                <div key={i} className="rounded-lg bg-ouro-void/40 px-3 py-3 ring-1 ring-ouro-moss/15">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => nav({ tab: "sessions" })}
                      className="font-medium text-ouro-bone hover:text-ouro-glow transition-colors"
                    >
                      {item.friendName}
                    </button>
                    <span className="text-xs text-ouro-shadow">via {item.channel}</span>
                    <Badge color="yellow">waiting {relTime(new Date(item.timestamp).toISOString())}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-ouro-mist">{truncate(item.delegatedContent, 140)}</p>
                  <div className="mt-1.5 flex flex-wrap gap-2 text-xs">
                    {bridgeId && (
                      <button onClick={() => nav({ tab: "connections", focus: bridgeId })} className="text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2 hover:decoration-ouro-glow">
                        bridge: {bridgeId.slice(0, 12)}…
                      </button>
                    )}
                    {obligationId && (
                      <button onClick={() => nav({ tab: "work", focus: obligationId })} className="text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2 hover:decoration-ouro-glow">
                        obligation: {obligationId.slice(0, 16)}…
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
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
              const sessions = b.attachedSessions
              const task = b.task
              const isActive = b.lifecycle === "active"

              return (
                <div key={b.id} className={`rounded-lg px-3 py-3 ring-1 ${
                  isActive ? "bg-ouro-moss/10 ring-ouro-glow/12" : "bg-ouro-void/40 ring-ouro-moss/15"
                }`}>
                  {/* Line 1: lifecycle + objective (the "why should I care" sentence) */}
                  <div className="flex items-start gap-2">
                    <Badge color={isActive ? "lime" : "zinc"}>{b.lifecycle}</Badge>
                    <p className="font-medium text-ouro-bone">{b.objective}</p>
                  </div>

                  {/* Line 2: summary — the short explanation */}
                  {b.summary && (
                    <p className="mt-1 text-sm text-ouro-mist">{truncate(b.summary, 160)}</p>
                  )}

                  {/* Attached sessions — clickable, shows who's involved */}
                  {sessions.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {sessions.map((s, i) => (
                        <button
                          key={i}
                          onClick={() => nav({ tab: "sessions", focus: `${s.friendId}/${s.channel}/${s.key}` })}
                          className="rounded-md bg-ouro-moss/10 px-2 py-0.5 font-mono text-[11px] text-ouro-glow ring-1 ring-ouro-moss/12 hover:ring-ouro-glow/25 transition-colors"
                        >
                          {s.friendId}/{s.channel}/{s.key}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Linked task */}
                  {task && (
                    <p className="mt-1.5 text-xs">
                      <button onClick={() => nav({ tab: "work" })} className="text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2 hover:decoration-ouro-glow">
                        task: {task.taskName}
                      </button>
                      <span className="text-ouro-shadow"> ({task.mode})</span>
                    </p>
                  )}

                  <p className="mt-1 text-xs text-ouro-shadow">{relTime(b.updatedAt)}</p>
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
              <div key={f.friendId} className="flex items-center justify-between rounded-lg bg-ouro-void/40 px-3 py-2.5 ring-1 ring-ouro-moss/15">
                <div className="min-w-0">
                  <button onClick={() => nav({ tab: "sessions" })} className="font-medium text-ouro-bone hover:text-ouro-glow transition-colors">
                    {f.friendName}
                  </button>
                  <p className="text-xs text-ouro-shadow">
                    {f.channels.join(", ")} · {f.sessionCount} sessions
                    {f.lastActivityAt && <> · {relTime(f.lastActivityAt)}</>}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="tabular-nums text-sm font-medium text-ouro-bone">{f.totalTokens.toLocaleString()}</p>
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
