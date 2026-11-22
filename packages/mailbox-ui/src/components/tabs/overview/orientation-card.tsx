import { Button } from "@/components/ouro/button/button"
import { Card } from "@/components/ouro/card/card"
import { DescriptionList, type DescriptionListItem } from "@/components/ouro/description-list/description-list"
import { Item } from "@/components/ouro/item/item"
import { SectionHeader } from "@/components/ouro/section-header/section-header"
import { Skeleton } from "@/components/ouro/skeleton/skeleton"
import { Text } from "@/components/ouro/text/text"
import { Badge } from "../../status-badge"
import { relTime, truncate } from "../../../api"
import type { NavigateFn } from "../../../navigation"
import type { MailboxOrientationView } from "../../../contracts"

/**
 * Orientation: the resume handle and the primary obligation. The loaded card keeps the
 * placeholder's minimum height, so an empty orientation does not shrink the page under the cards below.
 */
export function OrientationCard({ orientation, nav }: { orientation: MailboxOrientationView | null; nav: NavigateFn }) {
  if (orientation === null) return <Skeleton className="min-h-40" data-testid="orientation-loading" />

  const currentSession = orientation.currentSession
  const obligation = orientation.primaryObligation
  const handle = orientation.resumeHandle
  const handleItems: DescriptionListItem[] = handle
    ? ([
        ["Lane", handle.lane],
        ["Artifact", handle.artifact],
        ["Next", handle.nextAction],
        ["Blocked", handle.blockerOrWaitingOn],
      ] as const).flatMap(([term, details]) => (details ? [{ term, details }] : []))
    : []

  return (
    <Card headingLevel={2} title="Orientation" className="min-h-40" data-testid="orientation-loaded">
      <div className="space-y-3">
        {currentSession && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge color="lime">active session</Badge>
            <Button
              variant="plain"
              tone="primary"
              size="inline"
              onClick={() => nav({ tab: "sessions", focus: `${currentSession.friendId}/${currentSession.channel}/${currentSession.key}` })}
            >
              {currentSession.channel}/{currentSession.key}
            </Button>
            {currentSession.lastActivityAt && (
              <Text as="span" size="sm" tone="muted">{relTime(currentSession.lastActivityAt)}</Text>
            )}
          </div>
        )}

        {obligation && (
          <Item
            variant="outline"
            size="sm"
            title={truncate(obligation.content, 80)}
            description={(obligation.nextAction || obligation.waitingOn) && (
              <>
                {obligation.nextAction && <Text size="sm" tone="muted">Next: {obligation.nextAction}</Text>}
                {obligation.waitingOn && <Text size="sm" tone="muted">Waiting on: {obligation.waitingOn}</Text>}
              </>
            )}
            actions={<Badge color="yellow">{obligation.status}</Badge>}
          />
        )}

        {handle && (
          <Card
            size="sm"
            headingLevel={3}
            title="Resume handle"
            action={
              <Badge color={handle.confidence === "high" ? "lime" : handle.confidence === "medium" ? "yellow" : "zinc"}>
                {handle.confidence} confidence
              </Badge>
            }
          >
            {handleItems.length > 0 && <DescriptionList items={handleItems} />}
          </Card>
        )}

        {orientation.otherActiveSessions.length > 0 && (
          <div className="space-y-2">
            <SectionHeader level={3} divider={false} title="Other sessions" meta={orientation.otherActiveSessions.length} />
            <div className="flex flex-wrap gap-x-3 gap-y-1.5">
              {orientation.otherActiveSessions.slice(0, 5).map((s) => (
                <Button
                  key={`${s.friendId}/${s.channel}/${s.key}`}
                  variant="plain"
                  tone="primary"
                  size="inline"
                  onClick={() => nav({ tab: "sessions", focus: `${s.friendId}/${s.channel}/${s.key}` })}
                >
                  {s.friendName}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}
