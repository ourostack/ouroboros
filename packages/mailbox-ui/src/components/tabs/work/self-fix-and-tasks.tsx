import { Badge } from "../../status-badge"
import { Empty } from "@/components/ouro/empty/empty"
import { Item } from "@/components/ouro/item/item"
import { ItemGroup } from "@/components/ouro/item/item-group"
import { SectionHeader } from "@/components/ouro/section-header/section-header"
import { Text } from "@/components/ouro/text/text"
import type { MailboxAgentView, MailboxSelfFixView } from "../../../contracts"

/** The self-fix workflow's steps, in order, with the one under way. */
export function SelfFixSection({ selfFix }: { selfFix: MailboxSelfFixView }) {
  return (
    <section className="space-y-3">
      <SectionHeader title="Self-fix" meta={selfFix.active ? "active" : "inactive"} />
      {selfFix.currentStep && <Text size="sm" tone="primary">Current: {selfFix.currentStep}</Text>}
      <ItemGroup aria-label="Self-fix steps" ordered>
        {selfFix.steps.map((step, i) => (
          <Item
            key={i}
            size="sm"
            title={step.label}
            description={step.detail || undefined}
            actions={
              <Badge color={step.status === "done" ? "lime" : step.status === "active" ? "yellow" : "zinc"}>
                {step.status}
              </Badge>
            }
          />
        ))}
      </ItemGroup>
    </section>
  )
}

/** Live and blocked task counts, the live tasks' names, and the ones that need action. */
export function TasksSection({ tasks }: { tasks: MailboxAgentView["work"]["tasks"] }) {
  return (
    <section className="space-y-3">
      <SectionHeader title="Tasks" meta={`${tasks.liveCount} live, ${tasks.blockedCount} blocked`} />
      {tasks.liveTaskNames?.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {tasks.liveTaskNames.map((t) => <Badge key={t}>{t}</Badge>)}
        </div>
      ) : (
        <Empty variant="plain" align="start" title="No live tasks." />
      )}
      {tasks.actionRequired?.length > 0 && (
        <div className="space-y-1.5">
          <Text size="sm" tone="destructive">Action required</Text>
          <div className="flex flex-wrap gap-1.5">
            {tasks.actionRequired.map((t) => <Badge key={t} color="red">{t}</Badge>)}
          </div>
        </div>
      )}
    </section>
  )
}
