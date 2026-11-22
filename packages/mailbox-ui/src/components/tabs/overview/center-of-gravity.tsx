import type { ReactNode } from "react"
import { Alert } from "@/components/ouro/alert/alert"
import { Button } from "@/components/ouro/button/button"
import { Card } from "@/components/ouro/card/card"
import { Item } from "@/components/ouro/item/item"
import { ItemGroup } from "@/components/ouro/item/item-group"
import { Text } from "@/components/ouro/text/text"
import { truncate } from "../../../api"
import type { NavigateFn, TabId } from "../../../navigation"
import type { MailboxAgentView } from "../../../contracts"

/** The agent's center of gravity: what it is attending to, what it carries, and any runtime issues. */
export function CenterOfGravity({ view, nav }: { view: MailboxAgentView; nav: NavigateFn }) {
  const { agent, work } = view
  const degraded = agent.degraded
  const link = (tab: TabId, children: ReactNode) => (
    <Button variant="plain" tone="primary" size="inline" onClick={() => nav({ tab })}>{children}</Button>
  )

  return (
    <Card headingLevel={2} title="Center of gravity">
      <div className="space-y-3">
        <Text as="p" size="lg" className="font-semibold">{agent.attention.label}</Text>
        <Text size="sm" tone="muted">
          {agent.agentName} has{" "}
          {link("work", `${work.tasks.liveCount} live tasks`)},{" "}
          {link("work", `${work.obligations.openCount} obligations`)},{" "}
          {link("work", `${work.coding.activeCount} coding lanes`)}, and{" "}
          {link("sessions", `${work.sessions.liveCount} live sessions`)}.
        </Text>

        {degraded.status === "degraded" && degraded.issues.length > 0 && (
          <Alert
            tone="destructive"
            title="Runtime issues"
            description={
              <ItemGroup aria-label="Runtime issues">
                {degraded.issues.slice(0, 5).map((issue, i) => (
                  <Item
                    key={i}
                    size="sm"
                    title={issue.code}
                    description={truncate(issue.detail, 80)}
                    onSelect={() => nav({ tab: "runtime" })}
                  />
                ))}
              </ItemGroup>
            }
            action={degraded.issues.length > 5 ? (
              <Button variant="plain" tone="primary" size="sm" onClick={() => nav({ tab: "runtime" })}>
                +{degraded.issues.length - 5} more issues
              </Button>
            ) : undefined}
          />
        )}
      </div>
    </Card>
  )
}
