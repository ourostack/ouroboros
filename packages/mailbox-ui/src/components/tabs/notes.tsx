import { useEffect, useState } from "react"
import { Button } from "@/components/ouro/button/button"
import { Card } from "@/components/ouro/card/card"
import { Empty } from "@/components/ouro/empty/empty"
import { Item } from "@/components/ouro/item/item"
import { ItemGroup } from "@/components/ouro/item/item-group"
import { Skeleton } from "@/components/ouro/skeleton/skeleton"
import { Spinner } from "@/components/ouro/spinner/spinner"
import { Text } from "@/components/ouro/text/text"
import { Badge } from "../status-badge"
import { fetchJson, relTime } from "../../api"
import type { MailboxNoteDecisionView, MailboxNotesView } from "../../contracts"

type NotesViewMode = "diary" | "notes" | "decisions"

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
      <div aria-busy="true" className="space-y-3 py-6">
        <div className="flex items-center gap-2">
          <Spinner label="Loading…" />
          <Text as="span" size="sm" tone="muted" aria-hidden="true">Loading…</Text>
        </div>
        <Skeleton shape="card" count={3} />
      </div>
    )
  }

  const diaryEntries = data.recentDiaryEntries
  const canonicalNotes = data.recentCanonicalNotes
  const viewButton = (mode: NotesViewMode, label: string) => (
    <Button
      variant={view === mode ? "soft" : "plain"}
      tone={view === mode ? "primary" : "secondary"}
      size="sm"
      aria-pressed={view === mode}
      onClick={() => setView(mode)}
    >
      {label}
    </Button>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {viewButton("diary", `Diary (${data.diaryEntryCount})`)}
        {viewButton("notes", `Notes (${data.canonicalNoteCount})`)}
        {viewButton("decisions", `Decisions (${decisions?.totalCount ?? 0})`)}
      </div>

      {view === "diary" && (
        diaryEntries.length > 0 ? (
          <div className="space-y-3">
            {diaryEntries.map((e) => (
              <Card
                key={e.id}
                as="article"
                size="sm"
                footer={
                  <>
                    <Badge>{e.source}</Badge>
                    <Text as="span" size="sm" tone="muted">{relTime(e.createdAt)}</Text>
                  </>
                }
              >
                <Text size="sm">{e.text}</Text>
              </Card>
            ))}
          </div>
        ) : (
          <Empty title="No diary entries yet." description="The agent hasn't written anything down." />
        )
      )}

      {view === "notes" && (
        canonicalNotes.length > 0 ? (
          <div className="space-y-3">
            {canonicalNotes.map((note) => (
              <Card
                key={note.filename}
                as="article"
                size="sm"
                title={note.title}
                description={relTime(note.writtenAt)}
                footer={note.tags.length > 0 ? note.tags.map((tag) => <Badge key={tag}>{tag}</Badge>) : undefined}
              >
                <Text size="sm" tone="muted">{note.preview}</Text>
              </Card>
            ))}
          </div>
        ) : (
          <Empty title="No canonical notes yet." />
        )
      )}

      {view === "decisions" && (
        <ItemGroup variant="outline" aria-label="Note decisions" empty={<Empty title="No note decisions logged yet." />}>
          {(decisions?.items ?? []).map((d, i) => (
            <Item
              key={i}
              title={d.reason || d.kind.replace(/_/g, " ")}
              description={d.excerpt ? <span className="block truncate">{d.excerpt}</span> : undefined}
              actions={
                <>
                  <Badge color={d.decision === "saved" ? "lime" : "zinc"}>{d.decision}</Badge>
                  <Badge>{d.kind.replace(/_/g, " ")}</Badge>
                  <Text as="span" size="sm" tone="muted">{relTime(d.timestamp)}</Text>
                </>
              }
            />
          ))}
        </ItemGroup>
      )}
    </div>
  )
}
