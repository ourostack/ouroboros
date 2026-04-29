import { useEffect, useMemo, useState } from "react"
import { Badge } from "../../catalyst/badge"
import { fetchJson, relTime, truncate } from "../../api"
import type {
  MailboxMailFolder,
  MailboxMailMessageSummary,
  MailboxMailMessageView,
  MailboxMailOutboundRecord,
  MailboxMailView,
} from "../../contracts"

type MailFolderFilter = "all" | string

function addressLine(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "(unknown)"
}

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

function subjectLine(message: MailboxMailMessageSummary): string {
  return message.subject || "(no subject)"
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

function provenanceLabel(message: MailboxMailMessageSummary): string {
  if (message.provenance.compartmentKind === "delegated") {
    return `delegated human mailbox · ${message.provenance.ownerEmail ?? "unknown owner"} / ${message.provenance.source ?? "unknown source"}`
  }
  return "native agent mailbox"
}

function accessProvenanceLabel(entry: MailboxMailView["accessLog"][number]): string {
  if (entry.mailboxRole === "delegated-human-mailbox") {
    return `delegated human mailbox · ${entry.ownerEmail ?? "unknown owner"} / ${entry.source ?? "unknown source"}`
  }
  if (entry.mailboxRole === "agent-native-mailbox") return "native agent mailbox"
  return "mailbox"
}

function sendAuthorityLabel(record: MailboxMailOutboundRecord): string {
  if (record.sendAuthority === "agent-native") return "native agent mailbox"
  return record.mailboxRole
}

function outboundTransportLabel(record: MailboxMailOutboundRecord): string {
  return record.transport ?? record.provider ?? "not sent"
}

function outboundEventTime(record: MailboxMailOutboundRecord): string {
  return record.deliveredAt ?? record.failedAt ?? record.acceptedAt ?? record.sentAt ?? record.submittedAt ?? record.updatedAt
}

function pillClass(placement: string): string {
  if (placement === "screener") return "bg-[#fff7d6] text-[#6f5200] ring-[#e7c85c]"
  if (placement === "discarded" || placement === "quarantine") return "bg-[#ffe8e2] text-[#8a2f1f] ring-[#ef9a84]"
  if (placement === "sent") return "bg-[#dff7ea] text-[#17613a] ring-[#82caa1]"
  if (placement === "draft") return "bg-[#e7ecff] text-[#263f95] ring-[#a7b5f5]"
  return "bg-[#e9f3ef] text-[#1e5840] ring-[#9fc7b5]"
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
      <div className="mailbox-shell grid min-h-[58vh] place-items-center rounded-md bg-[#f2f6ef] p-8 text-[#1f2720] ring-1 ring-black/10">
        <div className="max-w-lg text-center">
          <p className="text-sm font-semibold text-[#667067]">Mailbox</p>
          <h2 className="mt-2 text-2xl font-semibold">{view.status === "auth-required" ? "Locked" : "Unavailable"}</h2>
          <p className="mt-3 text-sm leading-6 text-[#59645c]">{view.error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="mailbox-shell overflow-hidden rounded-md bg-[#f2f6ef] text-[#172018] ring-1 ring-black/10">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#cbd8c8] bg-[#e4ecdf] px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[#687062]">Agent mailbox</p>
          <p className="truncate text-sm text-[#2d3a30]">{view.mailboxAddress}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge color="zinc">read-only</Badge>
          <span className="text-xs tabular-nums text-[#687062]">{view.messages.length} messages</span>
          <span className="text-xs tabular-nums text-[#687062]">{view.outbound.length} outbound</span>
        </div>
      </header>

      <div className="grid min-h-[66vh] grid-cols-1 lg:grid-cols-[14.5rem_minmax(19rem,25rem)_minmax(0,1fr)]">
        <aside className="border-b border-[#cbd8c8] bg-[#e4ecdf] p-3 lg:border-b-0 lg:border-r">
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

        <section className="border-b border-[#cbd8c8] bg-[#fbfdf8] lg:border-b-0 lg:border-r">
          <div className="border-b border-[#d8e2d4] px-4 py-3">
            <p className="text-sm font-semibold text-[#172018]">{folders.find((folder) => folder.id === activeFolder)?.label ?? "All"}</p>
            <p className="text-xs text-[#687062]">
              {visibleOutbound.length > 0 ? `${visibleOutbound.length} outbound records` : `${visibleMessages.length} messages`}
            </p>
          </div>
          <div className="max-h-[66vh] overflow-y-auto">
            {visibleOutbound.map((record) => <OutboundRow key={record.id} record={record} />)}
            {visibleOutbound.length === 0 && visibleMessages.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                selected={selectedId === message.id}
                onSelect={() => setSelectedId(message.id)}
              />
            ))}
            {visibleOutbound.length === 0 && visibleMessages.length === 0 && (
              <div className="px-4 py-10 text-center text-sm text-[#687062]">No records here.</div>
            )}
          </div>
        </section>

        <main className="min-w-0 bg-[#fbfdf8]">
          {!selectedId && <EmptyReadingPane />}
          {selectedId && detailLoading && <Loading label="Opening message" />}
          {selectedId && !detailLoading && detail?.status !== "ready" && (
            <div className="grid min-h-[54vh] place-items-center p-8 text-center">
              <div>
                <p className="text-sm font-semibold text-[#172018]">Message unavailable</p>
                <p className="mt-2 text-sm text-[#687062]">{detail?.error}</p>
              </div>
            </div>
          )}
          {detail?.status === "ready" && detail.message && <ReadingPane detail={detail} />}
        </main>
      </div>
    </div>
  )
}

function FolderRail({ folders, activeFolder, setActiveFolder }: {
  folders: MailboxMailFolder[]
  activeFolder: MailFolderFilter
  setActiveFolder: (folder: string) => void
}) {
  return (
    <div className="space-y-1">
      {folders.map((folder) => (
        <button
          key={folder.id}
          type="button"
          onClick={() => setActiveFolder(folder.id)}
          className={`flex h-9 w-full items-center justify-between rounded px-3 text-left text-sm transition-colors ${
            activeFolder === folder.id ? "bg-[#fbfdf8] text-[#172018] shadow-sm" : "text-[#536157] hover:bg-[#fbfdf8]/65"
          }`}
        >
          <span className="truncate">{folder.label}</span>
          <span className="text-xs tabular-nums text-[#687062]">{folder.count}</span>
        </button>
      ))}
    </div>
  )
}

function RecoveryBlock({
  discarded,
  quarantine,
  undecryptable,
  missingKeyIds,
}: {
  discarded: number
  quarantine: number
  undecryptable: number
  missingKeyIds: string[]
}) {
  return (
    <div className="mt-5 border-t border-[#cbd8c8] pt-4">
      <p className="text-[11px] font-semibold text-[#687062]">Recovery drawers</p>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <div className="rounded border border-[#cbd8c8] bg-[#fbfdf8] px-3 py-2">
          <p className="text-xs text-[#687062]">Discarded</p>
          <p className="text-lg font-semibold tabular-nums text-[#172018]">{discarded}</p>
        </div>
        <div className="rounded border border-[#cbd8c8] bg-[#fbfdf8] px-3 py-2">
          <p className="text-xs text-[#687062]">Quarantine</p>
          <p className="text-lg font-semibold tabular-nums text-[#172018]">{quarantine}</p>
        </div>
        <div className="rounded border border-[#cbd8c8] bg-[#fbfdf8] px-3 py-2">
          <p className="text-xs text-[#687062]">Undecryptable</p>
          <p className="text-lg font-semibold tabular-nums text-[#172018]">{undecryptable}</p>
        </div>
      </div>
      {undecryptable > 0 && (
        <p className="mt-2 text-[11px] leading-4 text-[#687062]">
          missing key {missingKeyIds[0]}
          {missingKeyIds.length > 1 ? ` +${missingKeyIds.length - 1} more` : ""}
        </p>
      )}
    </div>
  )
}

function ScreenerBlock({ candidates, onOpen }: {
  candidates: MailboxMailView["screener"]
  onOpen: (messageId: string) => void
}) {
  return (
    <div className="mt-5 border-t border-[#cbd8c8] pt-4">
      <p className="text-[11px] font-semibold text-[#687062]">Screener</p>
      <div className="mt-2 space-y-2">
        {candidates.slice(0, 5).map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => onOpen(candidate.messageId)}
            className="block w-full rounded border border-[#cbd8c8] bg-[#fbfdf8] px-3 py-2 text-left hover:border-[#9fb8a7]"
          >
            <p className="truncate text-xs font-semibold text-[#172018]">{candidate.senderEmail}</p>
            <p className="mt-1 truncate text-xs text-[#687062]">{candidate.trustReason}</p>
          </button>
        ))}
        {candidates.length === 0 && <p className="text-xs text-[#687062]">No pending senders.</p>}
      </div>
    </div>
  )
}

function AccessBlock({ entries }: { entries: MailboxMailView["accessLog"] }) {
  return (
    <div className="mt-5 border-t border-[#cbd8c8] pt-4">
      <p className="text-[11px] font-semibold text-[#687062]">Access audit</p>
      <div className="mt-2 space-y-2">
        {entries.slice(0, 4).map((entry) => (
          <div key={entry.id} className="text-xs leading-4 text-[#687062]">
            <p className="truncate font-medium text-[#3f4b42]">{entry.tool}</p>
            <p className="truncate">{accessProvenanceLabel(entry)}</p>
            <p className="truncate">{entry.reason}</p>
          </div>
        ))}
        {entries.length === 0 && <p className="text-xs text-[#687062]">No reads yet.</p>}
      </div>
    </div>
  )
}

function MessageRow({ message, selected, onSelect }: {
  message: MailboxMailMessageSummary
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`block w-full border-b border-[#d8e2d4] px-4 py-3 text-left transition-colors ${
        selected ? "bg-[#eaf4ee]" : "hover:bg-[#eef4ec]"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-semibold text-[#172018]">{addressLine(message.from)}</p>
        <span className="shrink-0 text-xs tabular-nums text-[#687062]">{relTime(message.receivedAt)}</span>
      </div>
      <p className="mt-1 truncate text-sm text-[#26352a]">{subjectLine(message)}</p>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#687062]">{truncate(message.snippet, 150)}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-[11px] ring-1 ${pillClass(message.placement)}`}>{message.placement}</span>
        <span className="truncate text-[11px] text-[#687062]">{provenanceLabel(message)}</span>
      </div>
    </button>
  )
}

function OutboundRow({ record }: { record: MailboxMailOutboundRecord }) {
  const latestDeliveryEvent = record.deliveryEvents[record.deliveryEvents.length - 1]
  return (
    <div className="border-b border-[#d8e2d4] px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-semibold text-[#172018]">{record.subject || "(no subject)"}</p>
        <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] ring-1 ${pillClass(record.status)}`}>{record.status}</span>
      </div>
      <p className="mt-1 truncate text-xs text-[#536157]">to {addressLine(record.to)}</p>
      <p className="mt-1 text-xs text-[#687062]">{outboundTransportLabel(record)} · {relTime(outboundEventTime(record))}</p>
      <p className="mt-1 truncate text-xs text-[#687062]">
        {sendAuthorityLabel(record)} · {record.sendMode ?? "mode unknown"}
        {record.policyDecision ? ` · policy ${record.policyDecision.code} / ${record.policyDecision.fallback}` : ""}
      </p>
      {(record.providerMessageId || record.providerRequestId) && (
        <p className="mt-1 truncate text-xs text-[#687062]">
          provider {record.providerMessageId ?? "unknown"}{record.providerRequestId ? ` · request ${record.providerRequestId}` : ""}
        </p>
      )}
      {latestDeliveryEvent && (
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#687062]">{latestDeliveryEvent.bodySafeSummary}</p>
      )}
    </div>
  )
}

function ReadingPane({ detail }: { detail: MailboxMailMessageView }) {
  const message = detail.message!
  return (
    <article className="min-h-[66vh]">
      <header className="border-b border-[#cbd8c8] bg-[#fbfdf8] px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="min-w-0 text-xl font-semibold leading-tight text-[#172018]">{subjectLine(message)}</h2>
          <span className={`rounded px-2 py-0.5 text-xs ring-1 ${pillClass(message.placement)}`}>{message.placement}</span>
        </div>
        <div className="mt-4 grid gap-1 text-sm text-[#536157]">
          <p><span className="font-medium text-[#172018]">From:</span> {addressLine(message.from)}</p>
          <p><span className="font-medium text-[#172018]">To:</span> {addressLine(message.to)}</p>
          {message.cc.length > 0 && <p><span className="font-medium text-[#172018]">Cc:</span> {addressLine(message.cc)}</p>}
          <p><span className="font-medium text-[#172018]">Received:</span> {new Date(message.receivedAt).toLocaleString()}</p>
          <p><span className="font-medium text-[#172018]">Provenance:</span> {provenanceLabel(message)}</p>
        </div>
      </header>
      <div className="border-b border-[#f0d0bd] bg-[#fff4e4] px-6 py-3 text-sm text-[#8a4a18]">
        {message.untrustedContentWarning}
      </div>
      <div className="px-6 py-6">
        <pre className="whitespace-pre-wrap break-words font-body text-sm leading-7 text-[#26352a]">
          {message.text || "(no text body)"}
        </pre>
        {message.bodyTruncated && <p className="mt-4 text-xs text-[#687062]">Body truncated in Mailbox.</p>}
        <div className="mt-6 grid gap-3 border-t border-[#cbd8c8] pt-4 text-xs text-[#687062] md:grid-cols-2">
          <p><span className="font-medium text-[#172018]">Read reason:</span> {message.access.reason}</p>
          <p><span className="font-medium text-[#172018]">Read at:</span> {new Date(message.access.accessedAt).toLocaleString()}</p>
        </div>
        {message.attachments.length > 0 && (
          <div className="mt-6 border-t border-[#cbd8c8] pt-4">
            <p className="text-xs font-semibold text-[#687062]">Attachments</p>
            <div className="mt-2 space-y-2">
              {message.attachments.map((attachment) => (
                <div key={`${attachment.filename}-${attachment.size}`} className="rounded border border-[#cbd8c8] bg-[#fbfdf8] px-3 py-2 text-sm text-[#3f4b42]">
                  {attachment.filename} · {attachment.contentType} · {attachment.size.toLocaleString()} bytes
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </article>
  )
}

function EmptyReadingPane() {
  return (
    <div className="grid min-h-[54vh] place-items-center p-8 text-center">
      <div>
        <p className="text-sm font-semibold text-[#172018]">No message selected</p>
        <p className="mt-2 text-sm text-[#687062]">Reading pane idle.</p>
      </div>
    </div>
  )
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 p-6">
      <div className="h-2 w-2 animate-pulse rounded-full bg-[#2f8f4e]" />
      <span className="text-xs text-[#687062]">{label}...</span>
    </div>
  )
}
