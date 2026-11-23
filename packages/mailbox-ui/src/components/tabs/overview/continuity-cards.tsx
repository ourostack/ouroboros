import { Card } from "@/components/ouro/card/card"
import { DescriptionList } from "@/components/ouro/description-list/description-list"
import { Empty } from "@/components/ouro/empty/empty"
import { Item } from "@/components/ouro/item/item"
import { ItemGroup } from "@/components/ouro/item/item-group"
import { Separator } from "@/components/ouro/separator/separator"
import { Skeleton } from "@/components/ouro/skeleton/skeleton"
import { Text } from "@/components/ouro/text/text"
import { Badge } from "../../status-badge"
import { relTime } from "../../../api"
import type { MailboxContinuityView } from "../../../contracts"

const GRID = "grid gap-4 sm:grid-cols-3"

/**
 * Continuity: presence, cares and episodes. While continuity loads, the same three cards hold
 * its place, so nothing below moves when it lands.
 */
export function ContinuityCards({ continuity }: { continuity: MailboxContinuityView | null }) {
  if (continuity === null) {
    return (
      <div aria-busy="true" className={GRID} data-testid="continuity-loading">
        {["Presence", "Cares", "Episodes"].map((title) => (
          <Card key={title} headingLevel={2} title={title}>
            <Skeleton shape="text" size="sm" lines={2} />
          </Card>
        ))}
      </div>
    )
  }

  const self = continuity.presence.self
  const peers = continuity.presence.peers

  return (
    <div className={GRID}>
      <Card headingLevel={2} title="Presence">
        {self ? (
          <div className="space-y-2">
            <Text size="sm">{self.availability}</Text>
            {(self.lane || self.tempo) && (
              <DescriptionList
                items={[
                  ...(self.lane ? [{ term: "Lane", details: self.lane }] : []),
                  ...(self.tempo ? [{ term: "Tempo", details: self.tempo }] : []),
                ]}
              />
            )}
          </div>
        ) : (
          <Empty variant="plain" align="start" headingLevel={3} title="No presence data" />
        )}
        {peers.length > 0 && (
          <div className="mt-3 space-y-2">
            <Separator label="Peers" />
            <div className="flex flex-wrap gap-1.5">
              {peers.map((p) => (
                <Badge key={p.agentName} color={p.availability === "active" ? "lime" : "zinc"}>
                  {p.agentName}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card headingLevel={2} title={`Cares (${continuity.cares.activeCount})`}>
        <ItemGroup aria-label="Cares" empty={<Empty variant="plain" align="start" headingLevel={3} title="No active cares" />}>
          {continuity.cares.items.slice(0, 5).map((c) => (
            <Item
              key={c.id}
              size="sm"
              title={c.label}
              actions={
                <Badge color={c.salience === "high" ? "red" : c.salience === "medium" ? "yellow" : "zinc"}>
                  {c.salience}
                </Badge>
              }
            />
          ))}
        </ItemGroup>
      </Card>

      <Card headingLevel={2} title={`Episodes (${continuity.episodes.recentCount})`}>
        <ItemGroup aria-label="Episodes" empty={<Empty variant="plain" align="start" headingLevel={3} title="No recent episodes" />}>
          {continuity.episodes.items.slice(0, 5).map((ep) => (
            <Item
              key={ep.id}
              size="sm"
              title={ep.summary}
              description={relTime(ep.timestamp)}
              actions={<Badge color="zinc">{ep.kind}</Badge>}
            />
          ))}
        </ItemGroup>
      </Card>
    </div>
  )
}
