import { Badge } from "../../status-badge"
import { Alert } from "@/components/ouro/alert/alert"
import { Button } from "@/components/ouro/button/button"
import { CodeBlock } from "@/components/ouro/code-block/code-block"
import { Empty } from "@/components/ouro/empty/empty"
import { Item } from "@/components/ouro/item/item"
import { ItemGroup } from "@/components/ouro/item/item-group"
import { SectionHeader } from "@/components/ouro/section-header/section-header"
import { relTime, truncate } from "../../../api"
import type { NavigateFn } from "../../../navigation"
import type { MailboxCodingDeepItem } from "../../../contracts"

/** The agent's coding lanes: runner, workdir, the obligation and session each traces to, and a failed lane's exit. */
export function CodingLanesSection({ items, nav }: { items: MailboxCodingDeepItem[]; nav: NavigateFn }) {
  return (
    <section className="space-y-3">
      <SectionHeader title="Coding lanes" meta={items.length} />
      <ItemGroup aria-label="Coding lanes" empty={<Empty variant="plain" align="start" title="No coding sessions." />}>
        {items.map((c) => <CodingLaneRow key={c.id} lane={c} nav={nav} />)}
      </ItemGroup>
    </section>
  )
}

function CodingLaneRow({ lane: c, nav }: { lane: MailboxCodingDeepItem; nav: NavigateFn }) {
  const status = c.status
  const isFailed = status === "failed"
  const failure = c.failure
  const obligationId = c.obligationId
  const originSession = c.originSession
  return (
    <Item
      title={c.runner}
      actions={
        <Badge color={isFailed ? "red" : status === "running" ? "lime" : status === "completed" ? "zinc" : "yellow"}>
          {status}
        </Badge>
      }
      description={
        <div className="space-y-1.5">
          <p className="truncate">{c.workdir}</p>
          {(obligationId || c.taskRef || originSession) && (
            <div className="flex flex-wrap items-center gap-2">
              {obligationId && (
                <Button variant="plain" size="sm" onClick={() => nav({ tab: "work", focus: obligationId })}>
                  obligation: {obligationId.slice(0, 20)}…
                </Button>
              )}
              {c.taskRef && <span>task: {c.taskRef}</span>}
              {originSession && (
                <Button
                  variant="plain"
                  size="sm"
                  onClick={() => {
                    nav({ tab: "sessions", focus: `${originSession.friendId}/${originSession.channel}/${originSession.key}` })
                  }}
                >
                  origin session
                </Button>
              )}
            </div>
          )}
          {c.checkpoint && <p>{truncate(c.checkpoint, 100)}</p>}
          <p>
            pid {c.pid ?? "–"} · restarts {c.restartCount} · {relTime(c.lastActivityAt)}
          </p>
          {isFailed && failure && (
            <Alert
              tone="destructive"
              title="FAILURE:"
              description={
                <div className="space-y-2">
                  <p>{failure.command} exited {String(failure.code ?? failure.signal)}</p>
                  {failure.stderrTail && (
                    <CodeBlock code={failure.stderrTail} title="stderr" wrap className="max-h-40" />
                  )}
                </div>
              }
            />
          )}
        </div>
      }
    />
  )
}
