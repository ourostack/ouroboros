// The mui arm's reference solution: it shows the template and the grader work with this kit. Never shown to a model.
import { useState } from "react"
import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from "@kit/ui"

export default function RemoveCopy({ onRemove }: { onRemove: (copyId: number) => void }) {
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState(false)
  return (
    <main>
      <h1>The Harbour Almanac</h1>
      <ul>
        <li>
          Copy 187, unreadable{" "}
          {!done && <Button color="error" onClick={() => setOpen(true)}>Remove copy 187</Button>}
        </li>
        <li>Copy 189, the good one</li>
      </ul>
      <Dialog open={open} onClose={() => setOpen(false)} aria-labelledby="remove-title">
        <DialogTitle id="remove-title">Remove copy 187?</DialogTitle>
        <DialogContent>
          <DialogContentText>Copy 189 stays in your library.</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Keep it</Button>
          <Button color="error" onClick={() => { onRemove(187); setDone(true); setOpen(false) }}>Remove copy 187</Button>
        </DialogActions>
      </Dialog>
      <p role="status">{done ? "Copy 187 removed." : ""}</p>
    </main>
  )
}
