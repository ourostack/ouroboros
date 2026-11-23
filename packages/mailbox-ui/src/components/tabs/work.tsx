import { useEffect, useState } from "react"
import { fetchJson } from "../../api"
import { useNavigate } from "../../navigation"
import type {
  MailboxAgentView,
  MailboxCodingDeep,
  MailboxCodingDeepItem,
  MailboxObligationDetailItem,
  MailboxObligationDetailView,
  MailboxObligationItem,
  MailboxSelfFixView,
  MailboxSentinelView,
} from "../../contracts"
import { CodingLanesSection } from "./work/coding-lanes"
import { ObligationsSection } from "./work/obligations"
import { SelfFixSection, TasksSection } from "./work/self-fix-and-tasks"
import { SentinelSection } from "./work/sentinel"

export function WorkTab({ agentName, view, focus, onFocusConsumed, refreshGeneration }: { agentName: string; view: MailboxAgentView; focus?: string; onFocusConsumed?: () => void; refreshGeneration: number }) {
  const nav = useNavigate()
  const [coding, setCoding] = useState<MailboxCodingDeep | null>(null)
  const [obligationDetail, setObligationDetail] = useState<MailboxObligationDetailView | null>(null)
  const [selfFix, setSelfFix] = useState<MailboxSelfFixView | null>(null)
  const [sentinel, setSentinel] = useState<MailboxSentinelView | null>(null)
  const [sentinelError, setSentinelError] = useState<string | null>(null)
  const work = view.work
  const obligations = work.obligations
  const tasks = work.tasks

  useEffect(() => {
    let cancelled = false
    setCoding(null)
    setObligationDetail(null)
    setSelfFix(null)
    setSentinel(null)
    setSentinelError(null)
    fetchJson<MailboxCodingDeep>(`/agents/${encodeURIComponent(agentName)}/coding`)
      .then((view) => {
        if (!cancelled) setCoding(view)
      })
      .catch(() => {})
    fetchJson<MailboxObligationDetailView>(`/agents/${encodeURIComponent(agentName)}/obligations`)
      .then((view) => {
        if (!cancelled) setObligationDetail(view)
      })
      .catch(() => {})
    fetchJson<MailboxSelfFixView>(`/agents/${encodeURIComponent(agentName)}/self-fix`)
      .then((view) => {
        if (!cancelled) setSelfFix(view)
      })
      .catch(() => {})
    fetchJson<MailboxSentinelView>(`/agents/${encodeURIComponent(agentName)}/sentinel`)
      .then((view) => {
        if (cancelled) return
        setSentinel(view)
        setSentinelError(null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setSentinel(null)
        setSentinelError(error instanceof Error ? error.message : "sentinel unavailable")
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
      {(sentinel || sentinelError) && <SentinelSection view={sentinel} error={sentinelError} />}

      <ObligationsSection
        obligations={displayObligations}
        openCount={displayOpenCount}
        primarySelectionReason={obligationDetail?.primarySelectionReason}
        codingByObligation={codingByObligation}
        nav={nav}
      />

      {selfFix && selfFix.steps.length > 0 && <SelfFixSection selfFix={selfFix} />}

      <CodingLanesSection items={codingItems} nav={nav} />

      <TasksSection tasks={tasks} />
    </div>
  )
}
