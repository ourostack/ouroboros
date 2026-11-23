import { Skeleton } from "@/components/ouro/skeleton/skeleton"
import { Text } from "@/components/ouro/text/text"

/** Placeholder rows while something loads, named for screen readers, with the label beside them. */
export function Loading({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="group" aria-busy="true" aria-label={label} className="space-y-2 py-4">
      <Skeleton shape="row" count={rows} />
      <Text size="sm" tone="muted">{label}…</Text>
    </div>
  )
}
