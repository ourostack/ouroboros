import { useEffect, useState } from "react"
import { Badge } from "../../catalyst/badge"
import { fetchJson, relTime, truncate } from "../../api"
import { useNavigate } from "../../navigation"

interface ObligationItem {
  id: string
  status: string
  content: string
  updatedAt: string
  nextAction: string | null
  origin: { friendId: string; channel: string; key: string } | null
  currentSurface: { kind: string; label: string } | null
}

export function WorkTab({ agentName, view, focus, onFocusConsumed }: { agentName: string; view: Record<string, unknown>; focus?: string; onFocusConsumed?: () => void }) {
  const nav = useNavigate()
  const [coding, setCoding] = useState<Record<string, unknown> | null>(null)
  const work = view.work as Record<string, unknown>
  const obligations = work.obligations as { openCount: number; items: ObligationItem[] }
  const tasks = work.tasks as { liveCount: number; blockedCount: number; liveTaskNames: string[]; actionRequired: string[] }

  useEffect(() => {
    fetchJson<Record<string, unknown>>(`/agents/${encodeURIComponent(agentName)}/coding`).then(setCoding)
  }, [agentName])

  const codingItems = (coding?.items ?? []) as Array<Record<string, unknown>>

  // Build obligation→coding lane index for chain tracing
  const codingByObligation = new Map<string, Array<Record<string, unknown>>>()
  for (const c of codingItems) {
    const obId = c.obligationId as string | undefined
    if (obId) {
      if (!codingByObligation.has(obId)) codingByObligation.set(obId, [])
      codingByObligation.get(obId)!.push(c)
    }
  }

  return (
    <div className="space-y-8">
      {/* Obligations — with full chain tracing */}
      <section>
        <SH label={`Obligations (${obligations.openCount} open)`} />
        {obligations.items?.length > 0 ? (
          <div className="mt-3 space-y-3">
            {obligations.items.map((o) => {
              const linkedCoding = codingByObligation.get(o.id) ?? []
              return (
                <div key={o.id} className="rounded-lg bg-ouro-void/40 px-3 py-3 ring-1 ring-ouro-moss/15">
                  {/* Status + content */}
                  <div className="flex items-start gap-2">
                    <Badge color={o.status === "pending" ? "yellow" : o.status === "fulfilled" ? "lime" : "zinc"}>
                      {o.status}
                    </Badge>
                    <span className="text-sm font-medium text-ouro-bone">{truncate(o.content, 120)}</span>
                  </div>

                  {/* Chain: origin session */}
                  {o.origin && (
                    <div className="mt-2 flex items-center gap-1.5 text-xs">
                      <span className="text-ouro-shadow">triggered from</span>
                      <button
                        onClick={() => nav({ tab: "sessions", focus: `${o.origin!.friendId}/${o.origin!.channel}/${o.origin!.key}` })}
                        className="text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2 hover:decoration-ouro-glow"
                      >
                        {o.origin.friendId.slice(0, 8)}…/{o.origin.channel}/{o.origin.key}
                      </button>
                    </div>
                  )}

                  {/* Chain: current surface */}
                  {o.currentSurface && (
                    <div className="mt-1 text-xs text-ouro-mist">
                      surface: <span className="text-ouro-bone">{o.currentSurface.kind}</span> — {o.currentSurface.label}
                    </div>
                  )}

                  {/* Chain: linked coding lanes */}
                  {linkedCoding.length > 0 && (
                    <div className="mt-2 space-y-1">
                      <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-shadow">Linked coding</p>
                      {linkedCoding.map((c) => (
                        <div key={c.id as string} className="flex items-center gap-2 rounded bg-ouro-moss/10 px-2 py-1 text-xs">
                          <Badge color={(c.status as string) === "failed" ? "red" : (c.status as string) === "running" ? "lime" : "zinc"}>
                            {c.status as string}
                          </Badge>
                          <span className="text-ouro-mist truncate">{c.runner as string} — {c.workdir as string}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {o.nextAction && <p className="mt-1.5 text-xs text-ouro-mist">Next: {o.nextAction}</p>}
                  <p className="mt-1 text-xs text-ouro-shadow">{relTime(o.updatedAt)}</p>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="mt-2 text-sm text-ouro-shadow">No open obligations.</p>
        )}
      </section>

      {/* Coding lanes */}
      <section>
        <SH label={`Coding lanes (${codingItems.length})`} />
        {codingItems.length > 0 ? (
          <div className="mt-3 space-y-2">
            {codingItems.map((c) => {
              const status = c.status as string
              const isFailed = status === "failed"
              const failure = c.failure as Record<string, unknown> | null
              return (
                <div key={c.id as string} className="rounded-lg bg-ouro-void/40 px-3 py-3 ring-1 ring-ouro-moss/15">
                  <div className="flex items-center gap-2">
                    <Badge color={isFailed ? "red" : status === "running" ? "lime" : status === "completed" ? "zinc" : "yellow"}>
                      {status}
                    </Badge>
                    <span className="text-sm font-medium text-ouro-bone">{c.runner as string}</span>
                    <span className="truncate text-xs text-ouro-shadow">{c.workdir as string}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {c.obligationId && (
                      <button onClick={() => nav({ tab: "work", focus: c.obligationId as string })} className="text-xs text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2 hover:decoration-ouro-glow">
                        obligation: {(c.obligationId as string).slice(0, 20)}…
                      </button>
                    )}
                    {c.taskRef && <span className="text-xs text-ouro-glow">task: {c.taskRef as string}</span>}
                    {c.originSession && (
                      <button
                        onClick={() => {
                          const os = c.originSession as Record<string, string>
                          nav({ tab: "sessions", focus: `${os.friendId}/${os.channel}/${os.key}` })
                        }}
                        className="text-xs text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2 hover:decoration-ouro-glow"
                      >
                        origin session
                      </button>
                    )}
                  </div>
                  {c.checkpoint && <p className="mt-1.5 text-xs text-ouro-mist">{truncate(c.checkpoint as string, 100)}</p>}
                  <p className="mt-1 text-xs text-ouro-shadow">
                    pid {(c.pid as number) ?? "–"} · restarts {c.restartCount as number} · {relTime(c.lastActivityAt as string)}
                  </p>
                  {isFailed && failure && (
                    <div className="mt-2 rounded bg-ouro-fang/5 p-2 text-xs ring-1 ring-ouro-fang/15">
                      <span className="font-semibold text-ouro-fang">FAILURE:</span>{" "}
                      <span className="text-ouro-mist">{failure.command as string} exited {String(failure.code ?? failure.signal)}</span>
                      {(failure.stderrTail as string) && (
                        <pre className="mt-1 max-h-20 overflow-y-auto font-mono text-[11px] text-ouro-shadow whitespace-pre-wrap">{failure.stderrTail as string}</pre>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <p className="mt-2 text-sm text-ouro-shadow">No coding sessions.</p>
        )}
      </section>

      {/* Tasks */}
      <section>
        <SH label={`Tasks (${tasks.liveCount} live, ${tasks.blockedCount} blocked)`} />
        {tasks.liveTaskNames?.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tasks.liveTaskNames.map((t) => <Badge key={t}>{t}</Badge>)}
          </div>
        ) : (
          <p className="mt-2 text-sm text-ouro-shadow">No live tasks.</p>
        )}
        {tasks.actionRequired?.length > 0 && (
          <div className="mt-3">
            <p className="font-mono text-[10px] uppercase tracking-wider text-ouro-fang">Action required</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {tasks.actionRequired.map((t) => <Badge key={t} color="red">{t}</Badge>)}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function SH({ label }: { label: string }) {
  return <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-ouro-glow">{label}</p>
}
