import { useEffect, useState } from "react"
import { Badge } from "../../catalyst/badge"
import { fetchJson, relTime } from "../../api"
import type { MailboxNoteDecisionView, MailboxNotesView } from "../../contracts"

type NotesViewMode = "diary" | "journal" | "notes" | "decisions"

export function NotesTab({ agentName, refreshGeneration }: { agentName: string; refreshGeneration: number }) {
  const [data, setData] = useState<MailboxNotesView | null>(null)
  const [decisions, setDecisions] = useState<MailboxNoteDecisionView | null>(null)
  const [view, setView] = useState<NotesViewMode>("diary")

  useEffect(() => {
    fetchJson<MailboxNotesView>(`/agents/${encodeURIComponent(agentName)}/notes`).then(setData)
    fetchJson<MailboxNoteDecisionView>(`/agents/${encodeURIComponent(agentName)}/note-decisions`).then(setDecisions).catch(() => {})
  }, [agentName, refreshGeneration])

  if (!data) {
    return (
      <div className="flex items-center gap-2 py-6">
        <div className="h-2 w-2 animate-pulse rounded-full bg-ouro-glow" />
        <span className="font-mono text-xs text-ouro-shadow">Loading…</span>
      </div>
    )
  }

  const diaryEntries = data.recentDiaryEntries
  const journalEntries = data.recentJournalEntries
  const canonicalNotes = data.recentCanonicalNotes

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setView("diary")}
          className={`font-mono text-xs uppercase tracking-wider transition-colors ${
            view === "diary" ? "text-ouro-glow" : "text-ouro-shadow hover:text-ouro-mist"
          }`}
        >
          Diary ({data.diaryEntryCount})
        </button>
        <span className="text-ouro-shadow/30">|</span>
        <button
          onClick={() => setView("journal")}
          className={`font-mono text-xs uppercase tracking-wider transition-colors ${
            view === "journal" ? "text-ouro-glow" : "text-ouro-shadow hover:text-ouro-mist"
          }`}
        >
          Journal ({data.journalEntryCount})
        </button>
        <span className="text-ouro-shadow/30">|</span>
        <button
          onClick={() => setView("notes")}
          className={`font-mono text-xs uppercase tracking-wider transition-colors ${
            view === "notes" ? "text-ouro-glow" : "text-ouro-shadow hover:text-ouro-mist"
          }`}
        >
          Notes ({data.canonicalNoteCount})
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
                <article key={e.id} className="rounded-xl bg-ouro-void/40 px-4 py-3.5 ring-1 ring-ouro-moss/15">
                  <p className="text-sm leading-relaxed text-ouro-bone">
                    {e.text}
                  </p>
                  <div className="mt-2 flex items-center gap-2 text-xs text-ouro-shadow">
                    <Badge>{e.source}</Badge>
                    <span>{relTime(e.createdAt)}</span>
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
                <article key={e.filename} className="rounded-xl bg-ouro-void/40 px-4 py-3.5 ring-1 ring-ouro-moss/15">
                  <p className="font-medium text-ouro-bone">{e.filename}</p>
                  <p className="mt-1 text-sm leading-relaxed text-ouro-mist">{e.preview}</p>
                </article>
              ))}
            </div>
          ) : (
            <p className="text-sm text-ouro-shadow italic">No journal entries yet.</p>
          )}
        </div>
      )}

      {view === "notes" && (
        <div>
          {canonicalNotes.length > 0 ? (
            <div className="space-y-3">
              {canonicalNotes.map((note) => (
                <article key={note.filename} className="rounded-xl bg-ouro-void/40 px-4 py-3.5 ring-1 ring-ouro-moss/15">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-ouro-bone">{note.title}</p>
                    <span className="text-xs text-ouro-shadow">{relTime(note.writtenAt)}</span>
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-ouro-mist">{note.preview}</p>
                  {note.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {note.tags.map((tag) => (
                        <Badge key={tag}>{tag}</Badge>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <p className="text-sm text-ouro-shadow italic">No canonical notes yet.</p>
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
            <p className="text-sm text-ouro-shadow italic">No note decisions logged yet.</p>
          )}
        </div>
      )}
    </div>
  )
}
