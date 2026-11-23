/**
 * The oracle for a file no fixture label covers (the agent built or edited an EPUB): the books CLI's own
 * `quality.check` from the pinned oracle ref, run on the host side in a throwaway container with no network, a
 * read-only root and every capability dropped. `booksLib` is the folder holding that ref's `booklib` package. A
 * checker that cannot run, or answers anything but true or false, grades the file as not readable.
 */
import { emitNervesEvent } from "../../nerves/runtime"
import type { Docker } from "./docker"

const CHECK = "import json, sys; sys.path.insert(0, '/oracle'); from booklib import quality; print(json.dumps(bool(quality.check('/book.epub')['ok'])))"

export function dockerOracle(input: { docker: Docker; image: string; booksLib: string }): (file: string) => Promise<boolean> {
  return async (file) => {
    try {
      const out = await input.docker.run([
        "run", "--rm", "--network", "none", "--log-driver", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--tmpfs", "/tmp:rw,size=64m", "-v", `${input.booksLib}:/oracle:ro`, "-v", `${file}:/book.epub:ro`, input.image, "python3", "-I", "-c", CHECK,
      ])
      const verdict = out.trim()
      if (verdict === "true" || verdict === "false") {
        emitNervesEvent({ component: "eval", event: "eval.oracle_graded", message: "graded an unlabelled file with the pinned checker", meta: { readable: verdict === "true" } })
        return verdict === "true"
      }
      throw new Error(`the checker answered ${verdict.slice(0, 80)}`)
    } catch (error) {
      emitNervesEvent({ component: "eval", level: "error", event: "eval.oracle_error", message: "the pinned checker could not grade a file", meta: { error: (error as Error).message } })
      return false
    }
  }
}
