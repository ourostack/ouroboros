import { useEffect, useState } from "react"
import { Badge } from "../../catalyst/badge"
import { fetchJson, relTime } from "../../api"

interface MemoryDecision {
  kind: string
  decision: string
  reason: string | null
  excerpt: string | null
  timestamp: string
}

interface MemoryDecisionView {
  totalCount: number
  items: MemoryDecision[]
}

export function MemoryTab({ agentName }: { agentName: string }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [decisions, setDecisions] = useState<MemoryDecisionView | null>(null)
  const [view, setView] = useState<"diary" | "journal" | "decisions">("diary")

  useEffect(() => {
    fetchJson<Record<string, unknown>>(`/agents/${encodeURIComponent(agentName)}/memory`).then(setData)
    fetchJson<MemoryDecisionView>(`/agents/${encodeURIComponent(agentName)}/memory-decisions`).then(setDecisions).catch(() => {})
  }, [agentName])

  if (!data) {
    return (
      <div className="flex items-center gap-2 py-6">
        <div className="h-2 w-2 animate-pulse rounded-full bg-ouro-glow" />
        <span className="font-mono text-xs text-ouro-shadow">Loading…</span>
      </div>
    )
  }

  const diaryEntries = (data.recentDiaryEntries ?? []) as Array<Record<string, unknown>>
  const journalEntries = (data.recentJournalEntries ?? []) as Array<Record<string, unknown>>

  return (
    <div className="space-y-4">
      {/* Toggle between diary and journal */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setView("diary")}
          className={`font-mono text-xs uppercase tracking-wider transition-colors ${
            view === "diary" ? "text-ouro-glow" : "text-ouro-shadow hover:text-ouro-mist"
          }`}
        >
          Diary ({data.diaryEntryCount as number})
        </button>
        <span className="text-ouro-shadow/30">|</span>
        <button
          onClick={() => setView("journal")}
          className={`font-mono text-xs uppercase tracking-wider transition-colors ${
            view === "journal" ? "text-ouro-glow" : "text-ouro-shadow hover:text-ouro-mist"
          }`}
        >
          Journal ({data.journalEntryCount as number})
        </button>
        <span className="text-ouro-shadow/30">|</span>
        <button
          onClick={() => setView("decisions")}
          className={`font-mono text-xs uppercase tracking-wider transition-colors ${
            view === "decisions" ? "text-ouro-glow" : "text-ouro-shadow hover:text-ouro-mist"
          }`}
        >
          Decisions ({decisions?.totalCount ?? 0})
        </button>
      </div>

      {view === "diary" && (
        <div>
          {diaryEntries.length > 0 ? (
            <div className="space-y-3">
              {diaryEntries.map((e) => (
                <article key={e.id as string} className="rounded-xl bg-ouro-void/40 px-4 py-3.5 ring-1 ring-ouro-moss/15">
                  <p className="text-sm leading-relaxed text-ouro-bone">
                    {e.text as string}
                  </p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-ouro-shadow">
                    <Badge>{e.source as string}</Badge>
                    <span>{relTime(e.createdAt as string)}</span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="text-sm text-ouro-shadow italic">No diary entries yet. The agent hasn't written anything down.</p>
          )}
        </div>
      )}

      {view === "journal" && (
        <div>
          {journalEntries.length > 0 ? (
            <div className="space-y-3">
              {journalEntries.map((e) => (
                <article key={e.filename as string} className="rounded-xl bg-ouro-void/40 px-4 py-3.5 ring-1 ring-ouro-moss/15">
                  <p className="font-medium text-ouro-bone">{e.filename as string}</p>
                  <p className="mt-1 text-sm leading-relaxed text-ouro-mist">{e.preview as string}</p>
                </article>
              ))}
            </div>
          ) : (
            <p className="text-sm text-ouro-shadow italic">No journal entries yet.</p>
          )}
        </div>
      )}

      {view === "decisions" && (
        <div>
          {decisions && decisions.items.length > 0 ? (
            <div className="space-y-2">
              {decisions.items.map((d, i) => (
                <div key={i} className="rounded-xl bg-ouro-void/40 px-4 py-3 ring-1 ring-ouro-moss/15">
                  <div className="flex items-center gap-2">
                    <Badge color={d.decision === "saved" ? "lime" : "zinc"}>
                      {d.decision}
                    </Badge>
                    <Badge>{d.kind.replace(/_/g, " ")}</Badge>
                    <span className="text-xs text-ouro-shadow">{relTime(d.timestamp)}</span>
                  </div>
                  {d.reason && <p className="mt-1 text-sm text-ouro-mist">{d.reason}</p>}
                  {d.excerpt && <p className="mt-0.5 text-xs text-ouro-shadow italic truncate">{d.excerpt}</p>}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-ouro-shadow italic">No memory decisions logged yet.</p>
          )}
        </div>
      )}
    </div>
  )
}
