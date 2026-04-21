import { useEffect, useMemo, useState } from "react"
import { Badge } from "../../catalyst/badge"
import { fetchJson, relTime, truncate } from "../../api"
import type {
  OutlookMailFolder,
  OutlookMailMessageSummary,
  OutlookMailMessageView,
  OutlookMailView,
} from "../../contracts"

type MailFolderFilter = "all" | string

function addressLine(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "(unknown)"
}

function folderMatches(message: OutlookMailMessageSummary, folderId: MailFolderFilter): boolean {
  if (folderId === "all") return true
  if (folderId === "imbox" || folderId === "screener") return message.placement === folderId
  if (folderId === "native" || folderId === "delegated") return message.compartmentKind === folderId
  if (folderId.startsWith("source:")) return message.source === folderId.slice("source:".length)
  return true
}

function subjectLine(message: OutlookMailMessageSummary): string {
  return message.subject || "(no subject)"
}

export function MailboxTab({ agentName, focus, onFocusConsumed, refreshGeneration }: {
  agentName: string
  focus?: string
  onFocusConsumed?: () => void
  refreshGeneration: number
}) {
  const [view, setView] = useState<OutlookMailView | null>(null)
  const [activeFolder, setActiveFolder] = useState<MailFolderFilter>("all")
  const [selectedId, setSelectedId] = useState<string | null>(focus ?? null)
  const [detail, setDetail] = useState<OutlookMailMessageView | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  useEffect(() => {
    setActiveFolder("all")
    setSelectedId(focus ?? null)
    setDetail(null)
  }, [agentName])

  useEffect(() => {
    setView(null)
    fetchJson<OutlookMailView>(`/agents/${encodeURIComponent(agentName)}/mail`)
      .then(setView)
      .catch(() => setView({
        status: "error",
        agentName,
        mailboxAddress: null,
        generatedAt: new Date().toISOString(),
        store: null,
        folders: [],
        messages: [],
        accessLog: [],
        error: "mail unavailable",
      }))
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
    fetchJson<OutlookMailMessageView>(`/agents/${encodeURIComponent(agentName)}/mail/${encodeURIComponent(selectedId)}`)
      .then(setDetail)
      .catch(() => setDetail({
        status: "error",
        agentName,
        mailboxAddress: view?.mailboxAddress ?? null,
        generatedAt: new Date().toISOString(),
        message: null,
        accessLog: [],
        error: "message unavailable",
      }))
      .finally(() => setDetailLoading(false))
  }, [agentName, selectedId, refreshGeneration])

  const folders = useMemo<OutlookMailFolder[]>(() => {
    const current = view?.folders ?? []
    const total = view?.messages.length ?? 0
    return [{ id: "all", label: "All", count: total }, ...current]
  }, [view])

  const visibleMessages = useMemo(() => {
    return (view?.messages ?? []).filter((message) => folderMatches(message, activeFolder))
  }, [activeFolder, view])

  if (!view) return <Loading label="Opening mailbox" />

  if (view.status !== "ready") {
    return (
      <div className="mailbox-shell grid min-h-[58vh] place-items-center rounded-md bg-[#f7f8fb] p-8 text-[#1f2937] ring-1 ring-black/10">
        <div className="max-w-lg text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.12em] text-[#64748b]">Mailbox</p>
          <h2 className="mt-2 text-2xl font-semibold">{view.status === "auth-required" ? "Locked" : "Unavailable"}</h2>
          <p className="mt-3 text-sm leading-6 text-[#475569]">{view.error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="mailbox-shell overflow-hidden rounded-md bg-[#f7f8fb] text-[#172033] ring-1 ring-black/10">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#d7dce6] bg-[#eef2f7] px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#64748b]">Mailbox</p>
          <p className="truncate text-sm text-[#334155]">{view.mailboxAddress}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge color="zinc">read-only</Badge>
          <span className="text-xs tabular-nums text-[#64748b]">{view.messages.length} visible</span>
        </div>
      </div>

      <div className="grid min-h-[64vh] grid-cols-1 lg:grid-cols-[13rem_minmax(18rem,24rem)_minmax(0,1fr)]">
        <aside className="border-b border-[#d7dce6] bg-[#eef2f7] p-3 lg:border-b-0 lg:border-r">
          <div className="space-y-1">
            {folders.map((folder) => (
              <button
                key={folder.id}
                type="button"
                onClick={() => setActiveFolder(folder.id)}
                className={`flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm transition-colors ${
                  activeFolder === folder.id ? "bg-white text-[#0f172a] shadow-sm" : "text-[#475569] hover:bg-white/60"
                }`}
              >
                <span>{folder.label}</span>
                <span className="text-xs tabular-nums text-[#64748b]">{folder.count}</span>
              </button>
            ))}
          </div>

          <div className="mt-6 border-t border-[#d7dce6] pt-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#64748b]">Access</p>
            <div className="mt-2 space-y-2">
              {view.accessLog.slice(0, 4).map((entry) => (
                <div key={entry.id} className="text-xs leading-4 text-[#64748b]">
                  <p className="truncate font-medium text-[#475569]">{entry.tool}</p>
                  <p className="truncate">{entry.reason}</p>
                </div>
              ))}
              {view.accessLog.length === 0 && <p className="text-xs text-[#64748b]">No reads yet.</p>}
            </div>
          </div>
        </aside>

        <section className="border-b border-[#d7dce6] bg-white lg:border-b-0 lg:border-r">
          <div className="border-b border-[#e2e8f0] px-4 py-3">
            <p className="text-sm font-semibold text-[#0f172a]">{folders.find((folder) => folder.id === activeFolder)?.label ?? "All"}</p>
            <p className="text-xs text-[#64748b]">{visibleMessages.length} messages</p>
          </div>
          <div className="max-h-[64vh] overflow-y-auto">
            {visibleMessages.map((message) => (
              <button
                key={message.id}
                type="button"
                onClick={() => setSelectedId(message.id)}
                className={`block w-full border-b border-[#edf2f7] px-4 py-3 text-left transition-colors ${
                  selectedId === message.id ? "bg-[#eaf3ff]" : "hover:bg-[#f8fafc]"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 truncate text-sm font-semibold text-[#0f172a]">{addressLine(message.from)}</p>
                  <span className="shrink-0 text-xs tabular-nums text-[#64748b]">{relTime(message.receivedAt)}</span>
                </div>
                <p className="mt-1 truncate text-sm text-[#1e293b]">{subjectLine(message)}</p>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#64748b]">{truncate(message.snippet, 150)}</p>
                <div className="mt-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-[#64748b]">
                  <span>{message.placement}</span>
                  <span>{message.source ?? message.compartmentKind}</span>
                  {message.attachmentCount > 0 && <span>{message.attachmentCount} attachments</span>}
                </div>
              </button>
            ))}
            {visibleMessages.length === 0 && (
              <div className="px-4 py-10 text-center text-sm text-[#64748b]">No messages.</div>
            )}
          </div>
        </section>

        <main className="min-w-0 bg-[#fbfcfe]">
          {!selectedId && <EmptyReadingPane />}
          {selectedId && detailLoading && <Loading label="Opening message" />}
          {selectedId && !detailLoading && detail?.status !== "ready" && (
            <div className="grid min-h-[54vh] place-items-center p-8 text-center">
              <div>
                <p className="text-sm font-semibold text-[#0f172a]">Message unavailable</p>
                <p className="mt-2 text-sm text-[#64748b]">{detail?.error}</p>
              </div>
            </div>
          )}
          {detail?.status === "ready" && detail.message && (
            <article className="min-h-[64vh]">
              <header className="border-b border-[#d7dce6] bg-white px-6 py-5">
                <h2 className="text-xl font-semibold leading-tight text-[#0f172a]">{subjectLine(detail.message)}</h2>
                <div className="mt-4 grid gap-1 text-sm text-[#475569]">
                  <p><span className="font-medium text-[#0f172a]">From:</span> {addressLine(detail.message.from)}</p>
                  <p><span className="font-medium text-[#0f172a]">To:</span> {addressLine(detail.message.to)}</p>
                  {detail.message.cc.length > 0 && <p><span className="font-medium text-[#0f172a]">Cc:</span> {addressLine(detail.message.cc)}</p>}
                  <p><span className="font-medium text-[#0f172a]">Received:</span> {new Date(detail.message.receivedAt).toLocaleString()}</p>
                </div>
              </header>
              <div className="border-b border-[#fee2e2] bg-[#fff7ed] px-6 py-3 text-sm text-[#9a3412]">
                {detail.message.untrustedContentWarning}
              </div>
              <div className="px-6 py-6">
                <pre className="whitespace-pre-wrap break-words font-body text-sm leading-7 text-[#1e293b]">
                  {detail.message.text || "(no text body)"}
                </pre>
                {detail.message.bodyTruncated && (
                  <p className="mt-4 text-xs text-[#64748b]">Body truncated in Outlook.</p>
                )}
                {detail.message.attachments.length > 0 && (
                  <div className="mt-6 border-t border-[#d7dce6] pt-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#64748b]">Attachments</p>
                    <div className="mt-2 space-y-2">
                      {detail.message.attachments.map((attachment) => (
                        <div key={`${attachment.filename}-${attachment.size}`} className="rounded border border-[#d7dce6] bg-white px-3 py-2 text-sm text-[#334155]">
                          {attachment.filename} · {attachment.contentType} · {attachment.size.toLocaleString()} bytes
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </article>
          )}
        </main>
      </div>
    </div>
  )
}

function EmptyReadingPane() {
  return (
    <div className="grid min-h-[54vh] place-items-center p-8 text-center">
      <div>
        <p className="text-sm font-semibold text-[#0f172a]">No message selected</p>
        <p className="mt-2 text-sm text-[#64748b]">Reading pane idle.</p>
      </div>
    </div>
  )
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 p-6">
      <div className="h-2 w-2 animate-pulse rounded-full bg-[#2563eb]" />
      <span className="text-xs text-[#64748b]">{label}...</span>
    </div>
  )
}
