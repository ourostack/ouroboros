import type { ReactNode } from "react"
import { Badge as OuroBadge } from "@/components/ouro/badge/badge"

const TONES: Record<string, "primary" | "secondary" | "destructive" | "success" | "warning"> = {
  lime: "success",
  red: "destructive",
  yellow: "warning",
  zinc: "secondary",
}

/** A status badge in Ouro HX's tones: `color` names the status (lime, red, yellow, zinc), as the mailbox's status code has always said it. */
export function Badge({ color, children }: { color?: string | undefined; children: ReactNode }) {
  return <OuroBadge tone={(color && TONES[color]) || "secondary"}>{children}</OuroBadge>
}
