import { useEffect, useState } from "react"
import { Badge } from "../../catalyst/badge"
import { fetchJson, relTime, truncate } from "../../api"
import { useNavigate } from "../../navigation"
import type {
  OutlookAgentView,
  OutlookCodingDeep,
  OutlookCodingDeepItem,
  OutlookObligationDetailItem,
  OutlookObligationDetailView,
  OutlookObligationItem,
  OutlookSelfFixView,
} from "../../contracts"

export function WorkTab({ agentName, view, focus, onFocusConsumed, refreshGeneration }: { agentName: string; view: OutlookAgentView; focus?: string; onFocusConsumed?: () => void; refreshGeneration: number }) {
  const nav = useNavigate()
  const [coding, setCoding] = useState<OutlookCodingDeep | null>(null)
  const [obligationDetail, setObligationDetail] = useState<OutlookObligationDetailView | null>(null)
  const [selfFix, setSelfFix] = useState<OutlookSelfFixView | null>(null)
  const work = view.work
  const obligations = work.obligations
  const tasks = work.tasks

  useEffect(() => {
    fetchJson<OutlookCodingDeep>(`/agents/${encodeURIComponent(agentName)}/coding`).then(setCoding)
    fetchJson<OutlookObligationDetailView>(`/agents/${encodeURIComponent(agentName)}/obligations`).then(setObligationDetail).catch(() => {})
    fetchJson<OutlookSelfFixView>(`/agents/${encodeURIComponent(agentName)}/self-fix`).then(setSelfFix).catch(() => {})
  }, [agentName, refreshGeneration])

  // Use enriched obligations when available, fall back to summary
  const displayObligations: Array<OutlookObligationDetailItem | OutlookObligationItem> = obligationDetail?.items ?? obligations.items
  const displayOpenCount = obligationDetail?.openCount ?? obligations.openCount

  const codingItems = coding?.items ?? []

  // Build obligation→coding lane index for chain tracing
  const codingByObligation = new Map<string, OutlookCodingDeepItem[]>()
  for (const c of codingItems) {
    const obId = c.obligationId
    if (obId) {
      const linkedCoding = codingByObligation.get(obId)
      if (linkedCoding) {
        linkedCoding.push(c)
      } else {
        codingByObligation.set(obId, [c])
      }
    }
  }

  return (
    <div className="space-y-8">
      {/* Obligations — with full chain tracing */}
      <section>
        <SH label={`Obligations (${displayOpenCount} open)`} />
        {obligationDetail?.primarySelectionReason && (
          <p className="mt-1 text-xs text-ouro-shadow">Primary: {obligationDetail.primarySelectionReason}</p>
        )}
        {displayObligations.length > 0 ? (
          <div className="mt-3 space-y-3">
            {displayObligations.map((o) => {
              const linkedCoding = codingByObligation.get(o.id) ?? []
              const detail = isDetailedObligation(o) ? o : null
              const isPrimary = detail?.isPrimary ?? false
              const meaning = detail?.meaning ?? null
              const origin = o.origin
              return (
                <div key={o.id} className={`rounded-lg px-3 py-3 ring-1 ${isPrimary ? "bg-ouro-glow/5 ring-ouro-glow/20" : "bg-ouro-void/40 ring-ouro-moss/15"}`}>
                  {/* Status + content */}
                  <div className="flex items-start gap-2">
                    {isPrimary && <Badge color="lime">primary</Badge>}
                    <Badge color={o.status === "pending" ? "yellow" : o.status === "fulfilled" ? "lime" : "zinc"}>
                      {o.status}
                    </Badge>
                    <span className="text-sm font-medium text-ouro-bone">{truncate(o.content, 120)}</span>
                  </div>

                  {/* Chain: origin session — clickable card */}
                  {origin && (
                    <button
                      onClick={() => nav({ tab: "sessions", focus: `${origin.friendId}/${origin.channel}/${origin.key}` })}
                      className="mt-2 flex w-full items-center gap-2 rounded-md bg-ouro-moss/8 px-2.5 py-1.5 text-left text-xs ring-1 ring-ouro-moss/10 hover:ring-ouro-glow/20 transition-colors"
                    >
                      <span className="text-ouro-shadow">from</span>
                      <span className="font-medium text-ouro-glow">{origin.channel}</span>
                      <span className="text-ouro-shadow">&rarr;</span>
                      <span className="text-ouro-mist truncate">{origin.key}</span>
                      <span className="ml-auto text-ouro-shadow">open session &rarr;</span>
                    </button>
                  )}

                  {/* Chain: current surface */}
                  {o.currentSurface && (
                    <div className="mt-1 text-xs text-ouro-mist">
                      surface: <span className="text-ouro-bone">{o.currentSurface.kind}</span> — {o.currentSurface.label}
                    </div>
                  )}

                  {/* Waiting on */}
                  {meaning?.waitingOn && (
                    <p className="mt-1 text-xs text-ouro-shadow">Waiting on: {meaning.waitingOn}</p>
                  )}

                  {/* Chain: linked coding lanes */}
                  {linkedCoding.length > 0 && (
                    <div className="mt-2 space-y-1">
                      <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-shadow">Linked coding</p>
                      {linkedCoding.map((c) => (
                        <div key={c.id} className="flex items-center gap-2 rounded bg-ouro-moss/10 px-2 py-1 text-xs">
                          <Badge color={c.status === "failed" ? "red" : c.status === "running" ? "lime" : "zinc"}>
                            {c.status}
                          </Badge>
                          <span className="text-ouro-mist truncate">{c.runner} — {c.workdir}</span>
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

      {/* Self-fix workflow */}
      {selfFix && selfFix.steps.length > 0 && (
        <section>
          <SH label={`Self-fix ${selfFix.active ? "(active)" : "(inactive)"}`} />
          {selfFix.currentStep && (
            <p className="mt-1 text-xs text-ouro-glow">Current: {selfFix.currentStep}</p>
          )}
          <div className="mt-3 space-y-1.5">
            {selfFix.steps.map((step, i) => (
              <div
                key={i}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 ring-1 ${
                  step.status === "active" ? "bg-ouro-glow/5 ring-ouro-glow/20" :
                  step.status === "done" ? "bg-ouro-void/40 ring-ouro-glow/10" :
                  "bg-ouro-void/40 ring-ouro-moss/10"
                }`}
              >
                <Badge color={
                  step.status === "done" ? "lime" :
                  step.status === "active" ? "yellow" :
                  step.status === "skipped" ? "zinc" : "zinc"
                }>
                  {step.status}
                </Badge>
                <span className={`text-sm ${step.status === "active" ? "font-medium text-ouro-bone" : "text-ouro-mist"}`}>
                  {step.label}
                </span>
                {step.detail && <span className="ml-auto text-xs text-ouro-shadow">{step.detail}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Coding lanes */}
      <section>
        <SH label={`Coding lanes (${codingItems.length})`} />
        {codingItems.length > 0 ? (
          <div className="mt-3 space-y-2">
            {codingItems.map((c) => {
              const status = c.status
              const isFailed = status === "failed"
              const failure = c.failure
              const obligationId = c.obligationId
              const originSession = c.originSession
              return (
                <div key={c.id} className="rounded-lg bg-ouro-void/40 px-3 py-3 ring-1 ring-ouro-moss/15">
                  <div className="flex items-center gap-2">
                    <Badge color={isFailed ? "red" : status === "running" ? "lime" : status === "completed" ? "zinc" : "yellow"}>
                      {status}
                    </Badge>
                    <span className="text-sm font-medium text-ouro-bone">{c.runner}</span>
                    <span className="truncate text-xs text-ouro-shadow">{c.workdir}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {obligationId && (
                      <button onClick={() => nav({ tab: "work", focus: obligationId })} className="text-xs text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2 hover:decoration-ouro-glow">
                        obligation: {obligationId.slice(0, 20)}…
                      </button>
                    )}
                    {c.taskRef && <span className="text-xs text-ouro-glow">task: {c.taskRef}</span>}
                    {originSession && (
                      <button
                        onClick={() => {
                          nav({ tab: "sessions", focus: `${originSession.friendId}/${originSession.channel}/${originSession.key}` })
                        }}
                        className="text-xs text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2 hover:decoration-ouro-glow"
                      >
                        origin session
                      </button>
                    )}
                  </div>
                  {c.checkpoint && <p className="mt-1.5 text-xs text-ouro-mist">{truncate(c.checkpoint, 100)}</p>}
                  <p className="mt-1 text-xs text-ouro-shadow">
                    pid {c.pid ?? "–"} · restarts {c.restartCount} · {relTime(c.lastActivityAt)}
                  </p>
                  {isFailed && failure && (
                    <div className="mt-2 rounded bg-ouro-fang/5 p-2 text-xs ring-1 ring-ouro-fang/15">
                      <span className="font-semibold text-ouro-fang">FAILURE:</span>{" "}
                      <span className="text-ouro-mist">{failure.command} exited {String(failure.code ?? failure.signal)}</span>
                      {failure.stderrTail && (
                        <pre className="mt-1 max-h-20 overflow-y-auto font-mono text-[11px] text-ouro-shadow whitespace-pre-wrap">{failure.stderrTail}</pre>
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

function isDetailedObligation(
  obligation: OutlookObligationDetailItem | OutlookObligationItem,
): obligation is OutlookObligationDetailItem {
  return "isPrimary" in obligation
}
