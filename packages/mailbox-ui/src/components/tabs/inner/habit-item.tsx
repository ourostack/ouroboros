import { Badge } from "../../status-badge"
import { Item } from "@/components/ouro/item/item"
import { Text } from "@/components/ouro/text/text"
import { relTime } from "../../../api"
import type { MailboxHabitItem } from "../../../contracts"

/** A habit's row: its state, cadence and last run, and how confident to be that it fires. */
export function HabitItem({ h }: { h: MailboxHabitItem }) {
  const isOverdue = h.isOverdue
  const isDegraded = h.isDegraded
  const status = h.status

  return (
    <Item
      size="sm"
      title={h.title}
      actions={
        <Badge color={isOverdue ? "red" : isDegraded ? "yellow" : status === "active" ? "lime" : "zinc"}>
          {isOverdue ? "overdue" : isDegraded ? "degraded" : status}
        </Badge>
      }
      description={
        <>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {h.cadence && <span>every {h.cadence}</span>}
            <span>{h.lastRun ? `last ${relTime(h.lastRun)}` : "never run"}</span>
            {isDegraded && h.degradedReason && <Text as="span" size="sm" tone="warning">{h.degradedReason}</Text>}
            {/* Confidence indicator */}
            {!isOverdue && !isDegraded && status === "active" && h.lastRun && (
              <Text as="span" size="sm" tone="success">on schedule</Text>
            )}
            {isOverdue && h.overdueMs && (
              <Text as="span" size="sm" tone="destructive">{Math.floor(h.overdueMs / 60000)}m overdue</Text>
            )}
            {!h.lastRun && status === "active" && (
              <Text as="span" size="sm" tone="warning">never fired — may be misconfigured</Text>
            )}
          </div>
          {h.bodyExcerpt && <Text size="sm" tone="default" className="mt-1">{h.bodyExcerpt}</Text>}
        </>
      }
    />
  )
}
