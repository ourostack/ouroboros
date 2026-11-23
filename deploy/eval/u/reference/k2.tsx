// The shadcn arm's reference solution: it shows the template and the grader work with this kit. Never shown to a model.
import { useState } from "react"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger, Button,
} from "@kit/ui"

export default function RemoveCopy({ onRemove }: { onRemove: (copyId: number) => void }) {
  const [done, setDone] = useState(false)
  return (
    <main>
      <h1>The Harbour Almanac</h1>
      <ul>
        <li>
          Copy 187, unreadable{" "}
          {!done && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive">Remove copy 187</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove copy 187?</AlertDialogTitle>
                  <AlertDialogDescription>Copy 189 stays in your library.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it</AlertDialogCancel>
                  <AlertDialogAction onClick={() => { onRemove(187); setDone(true) }}>Remove copy 187</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </li>
        <li>Copy 189, the good one</li>
      </ul>
      <p role="status">{done ? "Copy 187 removed." : ""}</p>
    </main>
  )
}
