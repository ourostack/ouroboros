import { Badge } from "@/components/ouro/badge/badge"
import { Card } from "@/components/ouro/card/card"
import { DescriptionList } from "@/components/ouro/description-list/description-list"
import { Separator } from "@/components/ouro/separator/separator"
import { Text } from "@/components/ouro/text/text"
import { relTime } from "../../../api"
import type { MailboxHabitRunSummary } from "../../../contracts"

type Tone = "success" | "warning" | "destructive" | "secondary"

function outcomeTone(outcome: MailboxHabitRunSummary["outcome"]): Tone {
  if (outcome === "error" || outcome === "blocked") return "destructive"
  if (outcome === "surfaced" || outcome === "wrote_arc" || outcome === "updated_desk" || outcome === "wrote_record") return "success"
  if (outcome === "no_change") return "secondary"
  return "warning"
}

/** One habit session's receipt: what it was allowed to do, what it tried, and what it left behind. */
export function HabitRunCard({ run }: { run: MailboxHabitRunSummary }) {
  const routes = run.permissionEnvelope.returnRoutes
  const attempts = run.surfaceAttempts
  const errors = run.errors ?? []
  const deniedTools = Array.from(new Set([
    ...run.permissionEnvelope.deniedTools,
    ...run.toolPolicy.deniedTools,
  ]))

  const routesDetails = (
    <div className="space-y-1.5">
      {routes.length > 0 ? routes.map((route, index) => {
        const path = [route.friendId, route.channel, route.key].filter(Boolean).join("/")
        return (
          <div key={`${route.kind}-${route.recipient}-${index}`} className="min-w-0">
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline">{route.kind}</Badge>
              <Badge variant="soft">{route.status}</Badge>
            </div>
            <p className="mt-0.5 break-all font-mono text-xs">{route.recipient}</p>
            {(route.friendId || route.channel || route.key) && path !== route.recipient && (
              <p className="mt-0.5 break-all font-mono text-xs">{path}</p>
            )}
            {route.reason && <Text size="sm" tone="muted" className="mt-0.5 break-words">{route.reason}</Text>}
          </div>
        )
      }) : <Text size="sm" tone="muted">none</Text>}
      <Text size="sm" tone="muted">outward {run.permissionEnvelope.canMessageOutward ? "allowed" : "closed"}</Text>
      {run.permissionEnvelope.warnings.map((warning, index) => (
        <Text key={`${warning}-${index}`} size="sm" tone="warning" className="break-words">{warning}</Text>
      ))}
    </div>
  )

  const attemptsDetails = attempts.length > 0 ? (
    <div className="space-y-1">
      {attempts.map((attempt, index) => (
        <div key={`${attempt.recipient}-${attempt.channel}-${index}`} className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{attempt.result}</Badge>
            <Text as="span" size="sm" tone="muted">{attempt.reason}</Text>
          </div>
          <p className="mt-0.5 break-all font-mono text-xs">
            {attempt.recipient}/{attempt.channel}
            {attempt.error ? ` - ${attempt.error}` : ""}
          </p>
        </div>
      ))}
    </div>
  ) : <Text size="sm" tone="muted">none</Text>

  const toolsDetails = (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1.5">
        {run.toolPolicy.grantedTools.map((tool) => (
          <Badge key={`granted-${tool}`} tone="success" variant="soft">{tool}</Badge>
        ))}
        {deniedTools.map((tool) => (
          <Badge key={`denied-${tool}`} tone="destructive" variant="soft">{tool}</Badge>
        ))}
        {run.toolPolicy.grantedTools.length === 0 && deniedTools.length === 0 && <Text as="span" size="sm" tone="muted">none</Text>}
      </div>
      {run.errorCount > 0 && <Text size="sm" tone="destructive">{run.errorCount} error{run.errorCount === 1 ? "" : "s"}</Text>}
      {errors.map((error, index) => (
        <Text key={`${run.runId}-error-${index}`} size="sm" tone="destructive" className="break-words">{error}</Text>
      ))}
    </div>
  )

  return (
    <Card
      as="article"
      size="sm"
      headingLevel={3}
      stackBelow="sm"
      title={run.habitName}
      description={<span className="break-all font-mono">{run.runId}</span>}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={outcomeTone(run.outcome)} variant="soft">{run.outcome}</Badge>
          <Badge variant="outline">{run.trigger}</Badge>
        </div>
      }
      footer={
        <Text as="span" size="sm" tone="muted">
          {relTime(run.endedAt)}
          {run.nextRunAt && <> · next {relTime(run.nextRunAt)}</>}
        </Text>
      }
    >
      <DescriptionList
        items={[
          { term: "routes", details: routesDetails },
          { term: "attempts", details: attemptsDetails },
          { term: "tools", details: toolsDetails },
        ]}
      />

      {(run.producedRefs.length > 0 || run.receiptLocator) && (
        <div className="mt-3 space-y-1.5">
          <Separator />
          {run.producedRefs.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {run.producedRefs.map((ref, index) => (
                <Badge key={`${ref.kind}-${ref.locator}-${index}`} variant="outline">
                  {ref.kind}: {ref.locator}
                </Badge>
              ))}
            </div>
          )}
          <p className="break-all font-mono text-xs">{run.receiptLocator}</p>
        </div>
      )}
    </Card>
  )
}
