import { useEffect, useMemo, useState } from "react"
import { Badge } from "../status-badge"
import { Card } from "@/components/ouro/card/card"
import { Empty } from "@/components/ouro/empty/empty"
import { Skeleton } from "@/components/ouro/skeleton/skeleton"
import { Text } from "@/components/ouro/text/text"
import { fetchJson } from "../../api"
import type {
  MailboxMailFolder,
  MailboxMailMessageSummary,
  MailboxMailMessageView,
  MailboxMailView,
} from "../../contracts"
import { MessageList } from "./mailbox/message-list"
import { AccessBlock, FolderRail, RecoveryBlock, ScreenerBlock } from "./mailbox/rail"
import { EmptyReadingPane, ReadingPane, UnavailableReadingPane } from "./mailbox/reading-pane"

type MailFolderFilter = "all" | string

function folderMatches(message: MailboxMailMessageSummary, folderId: MailFolderFilter): boolean {
  if (folderId === "all") return true
  if (["imbox", "screener", "discarded", "quarantine"].includes(folderId)) return message.placement === folderId
  if (folderId === "native" || folderId === "delegated") return message.compartmentKind === folderId
  if (folderId.startsWith("source:")) {
    const sourceSpec = folderId.slice("source:".length)
    const ownerSeparator = sourceSpec.indexOf(":")
    if (ownerSeparator === -1) return message.source === sourceSpec
    const source = sourceSpec.slice(0, ownerSeparator)
    const owner = sourceSpec.slice(ownerSeparator + 1)
    return message.source === source && (message.ownerEmail ?? "unknown-owner") === owner
  }
  return false
}

function mailboxFallback(agentName: string, error: string): MailboxMailView {
  return {
    status: "error",
    agentName,
    mailboxAddress: null,
    generatedAt: new Date().toISOString(),
    store: null,
    folders: [],
    messages: [],
    screener: [],
    outbound: [],
    recovery: { discardedCount: 0, quarantineCount: 0, undecryptableCount: 0, missingKeyIds: [] },
    accessLog: [],
    error,
  }
}

function messageFallback(agentName: string, mailboxAddress: string | null, error: string): MailboxMailMessageView {
  return {
    status: "error",
    agentName,
    mailboxAddress,
    generatedAt: new Date().toISOString(),
    message: null,
    accessLog: [],
    error,
  }
}

function folderTotal(view: MailboxMailView | null): number {
  return view?.messages.length ?? 0
}

export function MailboxTab({ agentName, focus, onFocusConsumed, refreshGeneration }: {
  agentName: string
  focus?: string
  onFocusConsumed?: () => void
  refreshGeneration: number
}) {
  const [view, setView] = useState<MailboxMailView | null>(null)
  const [activeFolder, setActiveFolder] = useState<MailFolderFilter>("all")
  const [selectedId, setSelectedId] = useState<string | null>(focus ?? null)
  const [detail, setDetail] = useState<MailboxMailMessageView | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  useEffect(() => {
    setActiveFolder("all")
    setSelectedId(focus ?? null)
    setDetail(null)
  }, [agentName])

  useEffect(() => {
    setView(null)
    fetchJson<MailboxMailView>(`/agents/${encodeURIComponent(agentName)}/mail`)
      .then(setView)
      .catch(() => setView(mailboxFallback(agentName, "mail unavailable")))
  }, [agentName, refreshGeneration])

  useEffect(() => {
    if (!focus) return
    setSelectedId(focus)
    onFocusConsumed?.()
  }, [focus, onFocusConsumed])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    setDetailLoading(true)
    fetchJson<MailboxMailMessageView>(`/agents/${encodeURIComponent(agentName)}/mail/${encodeURIComponent(selectedId)}`)
      .then(setDetail)
      .catch(() => setDetail(messageFallback(agentName, view?.mailboxAddress ?? null, "message unavailable")))
      .finally(() => setDetailLoading(false))
  }, [agentName, selectedId, refreshGeneration])

  const folders = useMemo<MailboxMailFolder[]>(() => {
    const current = view?.folders ?? []
    return [{ id: "all", label: "All", count: folderTotal(view) }, ...current]
  }, [view])

  const visibleMessages = useMemo(() => {
    return (view?.messages ?? []).filter((message) => folderMatches(message, activeFolder))
  }, [activeFolder, view])

  const visibleOutbound = useMemo(() => {
    if (activeFolder !== "draft" && activeFolder !== "sent") return []
    return (view?.outbound ?? []).filter((record) =>
      activeFolder === "draft" ? record.status === "draft" : record.status !== "draft")
  }, [activeFolder, view])

  if (!view) return <Loading label="Opening mailbox" />

  if (view.status !== "ready") {
    return (
      <Card title="Mailbox">
        <div className="grid min-h-[50vh] place-items-center">
          <Empty
            variant="plain"
            headingLevel={2}
            className="max-w-lg"
            title={view.status === "auth-required" ? "Locked" : "Unavailable"}
            description={view.error}
          />
        </div>
      </Card>
    )
  }

  return (
    <Card
      size="sm"
      title="Agent mailbox"
      description={<span className="block truncate">{view.mailboxAddress}</span>}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Badge color="zinc">read-only</Badge>
          <Text as="span" size="sm" tone="muted" className="tabular-nums">{view.messages.length} messages</Text>
          <Text as="span" size="sm" tone="muted" className="tabular-nums">{view.outbound.length} outbound</Text>
        </div>
      }
    >
      <div className="grid min-h-[66vh] grid-cols-1 gap-6 border-t border-border pt-4 lg:grid-cols-[14.5rem_minmax(19rem,25rem)_minmax(0,1fr)]">
        <aside className="space-y-6 lg:border-r lg:border-border lg:pr-4">
          <FolderRail folders={folders} activeFolder={activeFolder} setActiveFolder={setActiveFolder} />
          <RecoveryBlock
            discarded={view.recovery.discardedCount}
            quarantine={view.recovery.quarantineCount}
            undecryptable={view.recovery.undecryptableCount}
            missingKeyIds={view.recovery.missingKeyIds}
          />
          <ScreenerBlock
            candidates={view.screener}
            onOpen={(messageId) => {
              setActiveFolder("screener")
              setSelectedId(messageId)
            }}
          />
          <AccessBlock entries={view.accessLog} />
        </aside>

        <section className="min-w-0 lg:border-r lg:border-border lg:pr-4">
          <MessageList
            folderLabel={folders.find((folder) => folder.id === activeFolder)?.label ?? "All"}
            messages={visibleMessages}
            outbound={visibleOutbound}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </section>

        <main className="min-w-0">
          {!selectedId && <EmptyReadingPane />}
          {selectedId && detailLoading && <Loading label="Opening message" />}
          {selectedId && !detailLoading && detail?.status !== "ready" && <UnavailableReadingPane error={detail?.error} />}
          {detail?.status === "ready" && detail.message && <ReadingPane detail={detail} />}
        </main>
      </div>
    </Card>
  )
}

function Loading({ label }: { label: string }) {
  return (
    <div role="group" aria-busy="true" aria-label={label} className="space-y-2 p-6">
      <Skeleton shape="row" count={3} />
      <Text size="sm" tone="muted">{label}...</Text>
    </div>
  )
}
