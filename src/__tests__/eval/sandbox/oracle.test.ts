import { describe, expect, it } from "vitest"
import { dockerOracle } from "../../../eval/sandbox/oracle"
import type { Docker } from "../../../eval/sandbox/docker"

function docker(answer: string | Error, seen: string[][]): Docker {
  return {
    run: async (args) => { seen.push(args); if (answer instanceof Error) throw answer; return answer },
    start: () => { throw new Error("unused") },
  }
}

describe("dockerOracle", () => {
  it("runs the pinned checker on one file in a container with no network, read-only", async () => {
    const seen: string[][] = []
    const oracle = dockerOracle({ docker: docker("true\n", seen), image: "ouro-eval-household:local", booksLib: "/tmp/ouro-eval-x/oracle/lib" })
    expect(await oracle("/tmp/ouro-eval-x/work/books/work/1/a.epub")).toBe(true)
    const args = seen[0]!
    expect(args.slice(0, 2)).toEqual(["run", "--rm"])
    expect(args).toEqual(expect.arrayContaining(["--network", "none", "--read-only", "--cap-drop", "ALL", "--log-driver", "none"]))
    expect(args).toEqual(expect.arrayContaining(["--label", "ouro.eval=1"]))
    expect(args).toEqual(expect.arrayContaining(["/tmp/ouro-eval-x/oracle/lib:/oracle:ro", "/tmp/ouro-eval-x/work/books/work/1/a.epub:/book.epub:ro", "ouro-eval-household:local"]))
  })

  it("grades a file as not readable when the checker says so, answers nonsense or cannot run", async () => {
    expect(await dockerOracle({ docker: docker("false\n", []), image: "i", booksLib: "/l" })("/f")).toBe(false)
    expect(await dockerOracle({ docker: docker("maybe", []), image: "i", booksLib: "/l" })("/f")).toBe(false)
    expect(await dockerOracle({ docker: docker(new Error("no image"), []), image: "i", booksLib: "/l" })("/f")).toBe(false)
  })
})
