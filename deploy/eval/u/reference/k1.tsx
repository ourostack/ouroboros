// The ouro arm's reference solution: it shows the template and the grader work with this kit. Never shown to a model.
import { useState } from "react"
import { Button, ConfirmDialog } from "@kit/ui"

export default function RemoveCopy({ onRemove }: { onRemove: (copyId: number) => void }) {
  const [done, setDone] = useState(false)
  return (
    <main>
      <h1>The Harbour Almanac</h1>
      <ul>
        <li>
          Copy 187, unreadable{" "}
          {!done && (
            <ConfirmDialog
              title="Remove copy 187?"
              description="Copy 189 stays in your library."
              confirmLabel="Remove copy 187"
              cancelLabel="Keep it"
              tone="destructive"
              onConfirm={() => { onRemove(187); setDone(true) }}
              trigger={<Button>Remove copy 187</Button>}
            />
          )}
        </li>
        <li>Copy 189, the good one</li>
      </ul>
      <p role="status">{done ? "Copy 187 removed." : ""}</p>
    </main>
  )
}
