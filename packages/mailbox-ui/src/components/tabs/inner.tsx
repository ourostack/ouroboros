import { useEffect, useRef, useState } from "react"
import { Alert } from "@/components/ouro/alert/alert"
import { Badge } from "@/components/ouro/badge/badge"
import { Button } from "@/components/ouro/button/button"
import { Card } from "@/components/ouro/card/card"
import { Empty } from "@/components/ouro/empty/empty"
import { ItemGroup } from "@/components/ouro/item/item-group"
import { SectionHeader } from "@/components/ouro/section-header/section-header"
import { Skeleton } from "@/components/ouro/skeleton/skeleton"
import { Text } from "@/components/ouro/text/text"
import { fetchJson, relTime } from "../../api"
import { useNavigate } from "../../navigation"
import type {
  MailboxAgentView,
  MailboxHabitItem,
  MailboxHabitRunView,
  MailboxHabitView,
  MailboxSessionTranscript,
} from "../../contracts"
import { HabitItem } from "./inner/habit-item"
import { HabitRunCard } from "./inner/habit-run-card"
import { InnerTranscriptView } from "./inner/transcript-view"

export function InnerTab({ agentName, view, refreshGeneration }: { agentName: string; view: MailboxAgentView; refreshGeneration: number }) {
  const nav = useNavigate()
  const [habits, setHabits] = useState<MailboxHabitView | null>(null)
  const [habitRuns, setHabitRuns] = useState<MailboxHabitRunView | null>(null)
  const [habitRunsError, setHabitRunsError] = useState(false)
  const [transcript, setTranscript] = useState<MailboxSessionTranscript | null>(null)
  const [showTranscript, setShowTranscript] = useState(false)
  const transcriptRefreshRef = useRef<number | null>(null)
  const inner = view.inner

  useEffect(() => {
    fetchJson<MailboxHabitView>(`/agents/${encodeURIComponent(agentName)}/habits`).then(setHabits)
  }, [agentName, refreshGeneration])

  useEffect(() => {
    let cancelled = false
    setHabitRunsError(false)
    setHabitRuns(null)
    fetchJson<MailboxHabitRunView>(`/agents/${encodeURIComponent(agentName)}/habit-runs`)
      .then((data) => {
        if (!cancelled) setHabitRuns(data)
      })
      .catch(() => {
        if (!cancelled) setHabitRunsError(true)
      })
    return () => { cancelled = true }
  }, [agentName, refreshGeneration])

  useEffect(() => {
    if (!transcript) return
    if (transcriptRefreshRef.current === refreshGeneration) return
    transcriptRefreshRef.current = refreshGeneration
    fetchJson<MailboxSessionTranscript>(`/agents/${encodeURIComponent(agentName)}/inner-transcript`).then(setTranscript)
  }, [agentName, refreshGeneration, transcript !== null])

  function loadTranscript() {
    if (transcript) { setShowTranscript(!showTranscript); return }
    fetchJson<MailboxSessionTranscript>(`/agents/${encodeURIComponent(agentName)}/inner-transcript`)
      .then((data) => {
        transcriptRefreshRef.current = refreshGeneration
        setTranscript(data)
        setShowTranscript(true)
      })
  }

  const habitItems = habits?.items ?? []
  const habitRunItems = habitRuns?.items ?? []
  const overdueHabits = habitItems.filter((h) => h.isOverdue)
  const activeHealthy = habitItems.filter((h) => h.status === "active" && !h.isOverdue)
  const pausedHabits = habitItems.filter((h) => h.status === "paused")
  const innerOrigin = inner.mode === "deep" ? inner.origin : null
  const innerObligationStatus = inner.mode === "deep" ? inner.obligationStatus : null
  const queue = inner.returnObligationQueue

  // Find heartbeat specifically
  const heartbeat = habitItems.find((h) => h.name.toLowerCase() === "heartbeat")

  const habitRunsMeta = habitRuns
    ? `${habitRuns.totalCount} recorded${habitRuns.totalCount > habitRunItems.length ? ` · showing ${habitRunItems.length}/${habitRuns.totalCount}` : ""}`
    : habitRunsError ? "Run history unavailable" : "Loading runs"

  return (
    <div className="space-y-8">
      {/* Heartbeat — front and center */}
      {heartbeat && (
        <section className="space-y-3">
          <SectionHeader title="Heartbeat" />
          <Card size="sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={heartbeat.isOverdue ? "destructive" : "success"} variant="soft" dot>
                {heartbeat.isOverdue ? "Overdue" : "Healthy"}
              </Badge>
              <Text as="span" size="sm" tone="muted">
                every {heartbeat.cadence ?? "unknown"} · last {heartbeat.lastRun ? relTime(heartbeat.lastRun) : "never"}
              </Text>
            </div>
          </Card>
        </section>
      )}

      {/* Private runtime work status */}
      <section className="space-y-3">
        <SectionHeader title="Private runtime work" />
        <Card size="sm" title={inner.status} description={inner.summary ?? undefined}>
          <div className="space-y-1">
            <Text size="sm" tone="muted">
              {inner.hasPending ? "Private runtime work queued." : "No private runtime work."}
            </Text>
            {(queue.queuedCount > 0 || queue.runningCount > 0) && (
              <Text size="sm">
                Held work items:{" "}
                <span className="font-medium">{queue.queuedCount + queue.runningCount}</span>
                {" "}({queue.queuedCount} queued
                {queue.runningCount > 0 ? `, ${queue.runningCount} running` : ""})
                {queue.oldestActiveAt !== null && (
                  <span> · oldest {relTime(new Date(queue.oldestActiveAt).toISOString())}</span>
                )}
              </Text>
            )}
          </div>
          {innerOrigin && (
            <div className="mt-3">
              <Text size="sm" tone="muted">Triggered from</Text>
              <div className="mt-1 flex flex-wrap gap-2">
                <Button
                  variant="plain"
                  size="sm"
                  onClick={() => {
                    nav({ tab: "sessions", focus: `${innerOrigin.friendId}/${innerOrigin.channel}/${innerOrigin.key}` })
                  }}
                >
                  {innerOrigin.friendId.slice(0, 8)}…/{innerOrigin.channel}/{innerOrigin.key}
                </Button>
                {innerObligationStatus && (
                  <Button variant="plain" size="sm" onClick={() => nav({ tab: "work" })}>
                    obligation: {innerObligationStatus}
                  </Button>
                )}
              </div>
            </div>
          )}
        </Card>
      </section>

      {/* Habit session receipts — explicit private work ledger */}
      <section className="space-y-3">
        <SectionHeader title="Habit sessions" meta={habitRunsMeta} />
        {!habitRuns ? (
          habitRunsError
            ? <Alert tone="warning" title="Habit sessions unavailable." />
            : <Skeleton shape="card" size="sm" count={2} />
        ) : habitRunItems.length > 0 ? (
          <div className="space-y-2">
            {habitRunItems.map((run) => <HabitRunCard key={run.runId} run={run} />)}
          </div>
        ) : (
          <Empty title="No habit sessions recorded." variant="plain" align="start" />
        )}
      </section>

      {/* Private runtime — always show recent, load more on demand */}
      <section className="space-y-3">
        <SectionHeader title="Private runtime" meta={transcript ? `${transcript.messages.length} total` : undefined} />
        {!transcript ? (
          <Button variant="outline" fullWidth onClick={loadTranscript}>
            Load private runtime
          </Button>
        ) : (
          <InnerTranscriptView messages={transcript.messages} />
        )}
      </section>

      {/* Habits — triage */}
      <section className="space-y-3">
        <SectionHeader title="Habits" meta={habits?.totalCount ?? 0} />
        <HabitGroup label={`Overdue (${overdueHabits.length})`} habits={overdueHabits} />
        <HabitGroup label={`Running fine (${activeHealthy.length})`} habits={activeHealthy} />
        <HabitGroup label={`Paused (${pausedHabits.length})`} habits={pausedHabits} />
        {habitItems.length === 0 && (
          <Empty title="No habits configured." variant="plain" align="start" />
        )}
      </section>
    </div>
  )
}

function HabitGroup({ label, habits }: { label: string; habits: MailboxHabitItem[] }) {
  if (habits.length === 0) return null
  return (
    <ItemGroup label={label}>
      {habits.map((h) => <HabitItem key={h.name} h={h} />)}
    </ItemGroup>
  )
}
