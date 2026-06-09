import { useEffect, useState } from "react"
import { Badge } from "../../catalyst/badge"
import { fetchJson, relTime, truncate } from "../../api"
import { useNavigate } from "../../navigation"
import type {
  MailboxAgentView,
  MailboxCodingDeep,
  MailboxCodingDeepItem,
  MailboxContextLossGauntletCheck,
  MailboxContextLossGauntletView,
  MailboxObligationDetailItem,
  MailboxObligationDetailView,
  MailboxObligationItem,
  MailboxSelfFixView,
} from "../../contracts"

export function WorkTab({ agentName, view, focus, onFocusConsumed, refreshGeneration }: { agentName: string; view: MailboxAgentView; focus?: string; onFocusConsumed?: () => void; refreshGeneration: number }) {
  const nav = useNavigate()
  const [coding, setCoding] = useState<MailboxCodingDeep | null>(null)
  const [obligationDetail, setObligationDetail] = useState<MailboxObligationDetailView | null>(null)
  const [selfFix, setSelfFix] = useState<MailboxSelfFixView | null>(null)
  const [contextLossGauntlet, setContextLossGauntlet] = useState<MailboxContextLossGauntletView | null>(null)
  const [contextLossGauntletError, setContextLossGauntletError] = useState<string | null>(null)
  const work = view.work
  const obligations = work.obligations
  const tasks = work.tasks

  useEffect(() => {
    let cancelled = false
    setContextLossGauntlet(null)
    setContextLossGauntletError(null)
    fetchJson<MailboxCodingDeep>(`/agents/${encodeURIComponent(agentName)}/coding`).then(setCoding)
    fetchJson<MailboxObligationDetailView>(`/agents/${encodeURIComponent(agentName)}/obligations`).then(setObligationDetail).catch(() => {})
    fetchJson<MailboxSelfFixView>(`/agents/${encodeURIComponent(agentName)}/self-fix`).then(setSelfFix).catch(() => {})
    fetchJson<MailboxContextLossGauntletView>(`/agents/${encodeURIComponent(agentName)}/context-loss-gauntlet`)
      .then((report) => {
        if (cancelled) return
        setContextLossGauntlet(report)
        setContextLossGauntletError(null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setContextLossGauntlet(null)
        setContextLossGauntletError(error instanceof Error ? error.message : "context-loss gauntlet unavailable")
      })
    return () => {
      cancelled = true
    }
  }, [agentName, refreshGeneration])

  // Use enriched obligations when available, fall back to summary
  const displayObligations: Array<MailboxObligationDetailItem | MailboxObligationItem> = obligationDetail?.items ?? obligations.items
  const displayOpenCount = obligationDetail?.openCount ?? obligations.openCount

  const codingItems = coding?.items ?? []

  // Build obligation→coding lane index for chain tracing
  const codingByObligation = new Map<string, MailboxCodingDeepItem[]>()
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
      {/* Context-loss gauntlet */}
      {(contextLossGauntlet || contextLossGauntletError) && (
        <section>
          <SH label="Context-loss gauntlet" />
          <GauntletPanel report={contextLossGauntlet} error={contextLossGauntletError} />
        </section>
      )}

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

function GauntletPanel({ report, error }: { report: MailboxContextLossGauntletView | null; error: string | null }) {
  return (
    <div className="mt-3 rounded-lg bg-ouro-void/40 px-3 py-3 ring-1 ring-ouro-moss/15">
      {error && !report ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge color="red">unavailable</Badge>
          <span className="min-w-0 flex-1 break-words text-sm text-ouro-mist">{error}</span>
        </div>
      ) : report ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge color={gauntletVerdictColor(report.verdict)}>{report.verdict}</Badge>
            <span className="font-mono text-xs text-ouro-bone">score {report.score.percentage}%</span>
            <span className="text-xs text-ouro-shadow">
              points {report.score.earned}/{report.score.possible}
            </span>
            <span className="text-xs text-ouro-shadow">updated {relTime(report.generatedAt)}</span>
            <span className="min-w-[12rem] flex-1 break-words text-sm text-ouro-mist">{report.summary}</span>
          </div>

          <div className="mt-3 grid gap-3 border-t border-ouro-moss/10 pt-3 md:grid-cols-2">
            <div className="min-w-0">
              <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-shadow">Current ask</p>
              <p className="mt-1 break-words text-sm text-ouro-bone">
                {report.currentAsk.available ? truncate(report.currentAsk.value ?? "", 120) : "unavailable"}
              </p>
              <p className="mt-1 text-xs text-ouro-shadow">confidence: {report.currentAsk.confidence}</p>
            </div>
            <div className="min-w-0">
              <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-shadow">Next safe action</p>
              <p className="mt-1 break-words text-sm text-ouro-bone">{truncate(report.nextAction.summary, 120)}</p>
              <p className="mt-1 text-xs text-ouro-shadow">actor: {report.nextAction.actor}</p>
            </div>
          </div>

          <div className="mt-3 border-t border-ouro-moss/10 pt-2">
            {report.checks.map((check) => (
              <GauntletCheckRow key={check.id} check={check} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

function gauntletVerdictColor(verdict: MailboxContextLossGauntletView["verdict"]) {
  return verdict === "ready" ? "lime" : verdict === "watch" ? "yellow" : "red"
}

function gauntletCheckColor(status: MailboxContextLossGauntletCheck["status"]) {
  return status === "pass" ? "lime" : status === "warn" ? "yellow" : status === "fail" ? "red" : "zinc"
}

function gauntletStatusLabel(status: MailboxContextLossGauntletCheck["status"]) {
  return status === "not_applicable" ? "n/a" : status
}

function GauntletCheckRow({ check }: { check: MailboxContextLossGauntletCheck }) {
  const firstEvidence = check.evidence[0]?.locator ?? null
  return (
    <div className="grid gap-2 border-b border-ouro-moss/10 py-2 last:border-b-0 md:grid-cols-[150px_1fr_auto] md:items-start">
      <div className="flex items-center gap-2">
        <Badge color={gauntletCheckColor(check.status)}>{gauntletStatusLabel(check.status)}</Badge>
        <span className="text-xs text-ouro-mist">{check.label}</span>
      </div>
      <div className="min-w-0">
        <p className="break-words text-xs text-ouro-shadow">{check.detail}</p>
        {firstEvidence && <p className="mt-1 truncate font-mono text-[10px] text-ouro-moss">{firstEvidence}</p>}
      </div>
      <span className="font-mono text-xs text-ouro-shadow md:text-right">
        {check.maxScore > 0 ? `${check.score}/${check.maxScore}` : "n/a"}
      </span>
    </div>
  )
}

function isDetailedObligation(
  obligation: MailboxObligationDetailItem | MailboxObligationItem,
): obligation is MailboxObligationDetailItem {
  return "isPrimary" in obligation
}
