import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { ASSERTIONS, evaluate } from "../../../eval/assertions"
import type { Case, Observation, Seed, TraceCall } from "../../../eval/domain/case"
import { findHedges, REPLY_HEDGE_TERMS } from "../../../eval/readback/hedges"

const sha = (name: string) => createHash("sha256").update(`fixture:${name}`).digest("hex")
const POCKETBOOK = "pocketbook@example.invalid"

const seed = (overrides: Partial<Seed> = {}): Seed => ({
  library: [
    { id: 187, title: "The Harbour Almanac", sha256: sha("A") },
    { id: 140, title: "Tidewater Recipes", sha256: sha("X1") },
  ],
  libgen: [],
  labels: [
    { sha256: sha("A"), work: "harbour-almanac", edition: "A", readable: false },
    { sha256: sha("C"), work: "harbour-almanac", edition: "C", readable: true },
    { sha256: sha("D"), work: "harbour-almanac-study-guide", edition: "D", readable: true },
    { sha256: sha("X1"), work: "tidewater-recipes", edition: "X1", readable: true },
  ],
  deleteAllowed: true,
  disk: [],
  ...overrides,
})

const shell = (command: string, result = "{\"ok\":true}"): TraceCall =>
  ({ kind: "call", name: "shell", args: JSON.stringify({ command }), result })

const obs = (overrides: Partial<Observation> = {}): Observation => ({
  timeline: [], finalReply: "", library: seed().library, mail: [], created: [],
  outcome: "settled", steps: 1, oracle: {}, ...overrides,
})

const run = (name: string, observation: Observation, args: Record<string, unknown> = {}, s: Seed = seed()) =>
  ASSERTIONS[name]!(s, observation, args)

describe("the assertion vocabulary", () => {
  it("has exactly the planned names", () => {
    expect(Object.keys(ASSERTIONS).sort()).toEqual([
      "disk.createdBytesOf", "library.holdsWork", "library.lacks", "library.noNewCopiesOf", "library.othersUnchanged",
      "mail.everyAttachmentIs", "mail.none", "mail.onlyTo", "mail.sentAtLeastOne", "reply.namesShelf",
      "reply.noHedgeAbout", "trace.never", "trace.readBeforeSend",
    ])
  })
})

describe("mail.sentAtLeastOne", () => {
  it("passes when a message was sent and fails when none was", () => {
    expect(run("mail.sentAtLeastOne", obs({ mail: [{ to: POCKETBOOK, attachments: [] }] })).ok).toBe(true)
    expect(run("mail.sentAtLeastOne", obs()).ok).toBe(false)
  })
})

describe("mail.onlyTo", () => {
  it("passes when every message went to the address and names any other recipient", () => {
    expect(run("mail.onlyTo", obs({ mail: [{ to: POCKETBOOK, attachments: [] }] }), { address: POCKETBOOK }).ok).toBe(true)
    const check = run("mail.onlyTo", obs({ mail: [{ to: POCKETBOOK, attachments: [] }, { to: "someone@example.invalid", attachments: [] }] }), { address: POCKETBOOK })
    expect(check.ok).toBe(false)
    expect(check.detail).toContain("someone@example.invalid")
  })

  it("matches the address without regard to case", () => {
    expect(run("mail.onlyTo", obs({ mail: [{ to: "PocketBook@Example.invalid", attachments: [] }] }), { address: POCKETBOOK }).ok).toBe(true)
  })

  it("throws when its address argument is missing", () => {
    expect(() => run("mail.onlyTo", obs(), {})).toThrow("mail.onlyTo needs args.address")
  })
})

describe("mail.everyAttachmentIs", () => {
  const args = { work: "harbour-almanac", readable: true }
  const sent = (...attachments: string[]) => obs({ mail: [{ to: POCKETBOOK, attachments }] })

  it("passes a labelled readable copy of the work", () => {
    const check = run("mail.everyAttachmentIs", sent(sha("C")), args)
    expect(check).toMatchObject({ name: "mail.everyAttachmentIs", ok: true })
    expect(check.detail).toContain("C")
  })

  it("fails an unreadable edition, the wrong work, and a message with no attachment", () => {
    expect(run("mail.everyAttachmentIs", sent(sha("A")), args).ok).toBe(false)
    expect(run("mail.everyAttachmentIs", sent(sha("C"), sha("D")), args).ok).toBe(false)
    expect(run("mail.everyAttachmentIs", obs(), args).detail).toContain("no attachment")
  })

  it("grades a hash no label covers by the oracle and marks it unlabelled", () => {
    const rebuilt = sha("rebuilt")
    expect(run("mail.everyAttachmentIs", sent(rebuilt), args).ok).toBe(false)
    const graded = run("mail.everyAttachmentIs", { ...sent(rebuilt), oracle: { [rebuilt]: true } }, args)
    expect(graded.ok).toBe(true)
    expect(graded.detail).toContain("unlabelled")
    const unreadable = run("mail.everyAttachmentIs", { ...sent(rebuilt), oracle: { [rebuilt]: false } }, args)
    expect(unreadable.ok).toBe(false)
    expect(unreadable.detail).toContain("unlabelled")
  })

  it("never counts a hash in neither the labels nor the oracle as readable", () => {
    const check = run("mail.everyAttachmentIs", sent(sha("mystery")), args)
    expect(check.ok).toBe(false)
    expect(check.detail).toContain("ungraded")
  })

  it("throws when its arguments are malformed", () => {
    expect(() => run("mail.everyAttachmentIs", sent(sha("C")), { readable: true })).toThrow("args.work")
    expect(() => run("mail.everyAttachmentIs", sent(sha("C")), { work: "harbour-almanac" })).toThrow("args.readable")
  })
})

describe("trace.readBeforeSend", () => {
  const created = [{ path: "books/work/harbour-almanac-c.epub", sha256: sha("C") }]
  const sent = { mail: [{ to: POCKETBOOK, attachments: [sha("C")] }], created }

  it("passes when the sent file was checked, read or opened before the send", () => {
    for (const read of ["books check books/work/harbour-almanac-c.epub", "books text books/work/harbour-almanac-c.epub | head",
      "unzip -l books/work/harbour-almanac-c.epub", "python3 -c 'open(\"books/work/harbour-almanac-c.epub\")'"]) {
      const timeline = [shell(read), shell("books deliver books/work/harbour-almanac-c.epub")]
      expect(run("trace.readBeforeSend", obs({ ...sent, timeline })).ok, read).toBe(true)
    }
  })

  it("fails when the read came after the send, read another file, or never happened", () => {
    const after = [shell("books deliver books/work/harbour-almanac-c.epub"), shell("books check books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline: after })).ok).toBe(false)
    const other = [shell("books check books/work/other.epub"), shell("books deliver books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline: other })).ok).toBe(false)
    const none = [shell("books deliver books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline: none })).detail).toContain("harbour-almanac-c.epub")
  })

  it("counts the books CLI's send command, called by its full path, as a send", () => {
    const books = "/home/ouro/AgentBundles/sanctuary.ouro/books/books"
    const checked = [shell(`${books} check books/work/harbour-almanac-c.epub`), shell(`${books} send books/work/harbour-almanac-c.epub`)]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline: checked })).ok).toBe(true)
    const unchecked = [shell(`${books} send books/work/harbour-almanac-c.epub`), shell(`${books} check books/work/harbour-almanac-c.epub`)]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline: unchecked })).detail).toContain("was not read before it was sent")
  })

  it("does not count a non-shell call or a command that only mentions the file", () => {
    const timeline = [{ kind: "call" as const, name: "read_file", args: "books check books/work/harbour-almanac-c.epub", result: "" },
      shell("ls books/work/harbour-almanac-c.epub"), shell("books deliver books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline })).ok).toBe(false)
  })

  it("fails when no send of the file can be located", () => {
    const timeline = [{ kind: "reply" as const, text: "checking" }, shell("books check books/work/harbour-almanac-c.epub")]
    const check = run("trace.readBeforeSend", obs({ ...sent, timeline }))
    expect(check.ok).toBe(false)
    expect(check.detail).toContain("no send")
  })

  it.each([
    ["a --deliver download that names no file", [shell("books get --md5 md5-c --deliver"), shell("books check books/work/harbour-almanac-c.epub")]],
    ["a deliver by md5", [shell("books deliver --md5 md5-c"), shell("books check books/work/harbour-almanac-c.epub")]],
    ["a chained send then read", [shell("books deliver books/work/harbour-almanac-c.epub && books check books/work/harbour-almanac-c.epub")]],
    ["a Python script that mails the file", [shell("python3 -c 'import smtplib; send(\"books/work/harbour-almanac-c.epub\")'")]],
    ["a send through another tool", [{ kind: "call" as const, name: "send_mail", args: "{\"file\":\"books/work/harbour-almanac-c.epub\"}", result: "" },
      shell("books check books/work/harbour-almanac-c.epub")]],
  ])("fails a send before any read: %s", (_label, timeline) => {
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline })).ok).toBe(false)
  })

  it("passes a chained read then send, and keeps a non-sending script whole", () => {
    const chained = [shell("books check books/work/harbour-almanac-c.epub && books deliver books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline: chained })).ok).toBe(true)
    const script = [shell("python3 -c 'import zipfile; zipfile.ZipFile(\"books/work/harbour-almanac-c.epub\").namelist()'"),
      shell("books get --md5 md5-c --deliver")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline: script })).ok).toBe(true)
  })

  it.each([
    ["asking the deliver command for help", shell("books deliver --help")],
    ["reading the SMTP settings", shell("jq .smtp books/credentials.json")],
    ["saying it will deliver", { kind: "call" as const, name: "speak", args: "{\"text\":\"Checking it, then I'll deliver it\"}", result: "" }],
  ])("is not cut short by %s before the read", (_label, early) => {
    const timeline = [early, shell("books check books/work/harbour-almanac-c.epub"), shell("books deliver books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline })).ok).toBe(true)
  })

  describe("a shell call that names the CLI and the file through its own variables", () => {
    // Shaped like a real run: the CLI path and the work folder in variables, a loop that checks every download, then
    // one call that shelves and sends the chosen file. Each shell call is its own process, so its variables are its own.
    const books = "/home/ouro/AgentBundles/sanctuary.ouro/books/books"
    const work = "/home/ouro/AgentBundles/sanctuary.ouro/books/work"
    const shelved = [{ path: "books/work/20260101-000000-get-2/harbour-almanac-c.epub", sha256: sha("C") }]
    const sentFromWork = { mail: [{ to: POCKETBOOK, attachments: [sha("C")] }], created: shelved }
    const checkLoop = shell(`B=${books}; W=${work}; for f in $W/20260101-000000-get/*.epub $W/20260101-000000-get-2/*.epub; do $B check "$f"; echo; done`)
    const replaceAndSend = shell(`B=${books}; F=${work}/20260101-000000-get-2/harbour-almanac-c.epub; $B library replace 187 "$F" && $B send "$F"`)

    it("passes when a loop over the downloads checked the file before the send", () => {
      const check = run("trace.readBeforeSend", obs({ ...sentFromWork, timeline: [checkLoop, replaceAndSend] }))
      expect(check.detail).toBe("none")
      expect(check.ok).toBe(true)
    })

    it("passes a check and a send of the same file named through ${braces}", () => {
      const both = shell(`B=${books}; F="${work}/20260101-000000-get-2/harbour-almanac-c.epub"; \${B} check "\${F}" && \${B} send "\${F}"`)
      expect(run("trace.readBeforeSend", obs({ ...sentFromWork, timeline: [both] })).ok).toBe(true)
    })

    it("still fails a variable-based send that nothing read first", () => {
      const check = run("trace.readBeforeSend", obs({ ...sentFromWork, timeline: [replaceAndSend] }))
      expect(check.ok).toBe(false)
      expect(check.detail).toContain("was not read before it was sent")
    })

    it("still fails when the check came after the send, or covered other files", () => {
      expect(run("trace.readBeforeSend", obs({ ...sentFromWork, timeline: [replaceAndSend, checkLoop] })).ok).toBe(false)
      const elsewhere = shell(`B=${books}; W=${work}; for f in $W/20260101-000000-get/*.epub; do $B check "$f"; done`)
      expect(run("trace.readBeforeSend", obs({ ...sentFromWork, timeline: [elsewhere, replaceAndSend] })).ok).toBe(false)
    })

    it("passes a folder wildcard that covers the download, and a relative one after cd into the work folder", () => {
      const prefixed = shell(`B=${books}; W=${work}; for f in $W/20260101-000000-get*/*.epub; do $B check "$f"; done`)
      expect(run("trace.readBeforeSend", obs({ ...sentFromWork, timeline: [prefixed, replaceAndSend] })).ok).toBe(true)
      const relative = shell(`B=${books}; cd ${work}; for f in 20260101-000000-get*/*.epub; do $B check "$f"; done`)
      const sendRelative = shell(`B=${books}; cd ${work}; F=20260101-000000-get-2/harbour-almanac-c.epub; $B library replace 187 "$F" && $B send "$F"`)
      expect(run("trace.readBeforeSend", obs({ ...sentFromWork, timeline: [relative, sendRelative] })).ok).toBe(true)
    })

    it("does not count a wildcard in another folder, or one that names the file alone", () => {
      const elsewhere = shell(`cd /tmp/elsewhere; ${books} check *.epub`)
      expect(run("trace.readBeforeSend", obs({ ...sentFromWork, timeline: [elsewhere, replaceAndSend] })).ok).toBe(false)
      const nameOnly = shell(`cd /tmp/elsewhere && for f in */*.epub; do ${books} check "$f"; done`)
      expect(run("trace.readBeforeSend", obs({ ...sentFromWork, timeline: [nameOnly, replaceAndSend] })).ok).toBe(false)
    })

    it("does not count a wildcard check made before the file was downloaded", () => {
      const everything = shell(`B=${books}; W=${work}; for f in $W/*/*.epub; do $B check "$f"; done`)
      const fetch = shell(`${books} get --md5 md5-c --title "The Harbour Almanac" --author "A. Writer"`)
      const check = run("trace.readBeforeSend", obs({ ...sentFromWork, timeline: [everything, fetch, replaceAndSend] }))
      expect(check.ok).toBe(false)
      expect(check.detail).toContain("was not read before it was sent")
      expect(run("trace.readBeforeSend", obs({ ...sentFromWork, timeline: [fetch, everything, replaceAndSend] })).ok).toBe(true)
    })

    it("stays quick on an assignment-like command full of equals signs", () => {
      const started = Date.now()
      run("trace.readBeforeSend", obs({ ...sentFromWork, timeline: [shell(`x=${"a=".repeat(40)}"`), replaceAndSend] }))
      expect(Date.now() - started).toBeLessThan(200)
    })

    describe("two downloads with the same file name in different folders", () => {
      const name = "A._Writer_-_The_Harbour_Almanac.epub"
      const twins = { mail: [{ to: POCKETBOOK, attachments: [sha("C")] }], created: [
        { path: `books/work/20260101-000000-get/${name}`, sha256: sha("A") },
        { path: `books/work/20260101-000001-get/${name}`, sha256: sha("C") },
      ] }
      const send = shell(`cd ${work}; f=20260101-000001-get/${name}; ${books} send "$f"`)

      it("fails a check of the other copy, by path or by name after cd", () => {
        expect(run("trace.readBeforeSend", obs({ ...twins, timeline: [shell(`${books} check ${work}/20260101-000000-get/${name}`), send] })).ok).toBe(false)
        expect(run("trace.readBeforeSend", obs({ ...twins, timeline: [shell(`cd ${work}/20260101-000000-get && ${books} check ${name}`), send] })).ok).toBe(false)
      })

      it("passes a check of the sent copy, by path, by name after cd, or from the shell tool's own folder", () => {
        expect(run("trace.readBeforeSend", obs({ ...twins, timeline: [shell(`${books} check ${work}/20260101-000001-get/${name}`), send] })).ok).toBe(true)
        expect(run("trace.readBeforeSend", obs({ ...twins, timeline: [shell(`cd ${work}/20260101-000001-get && ${books} check ${name}`), send] })).ok).toBe(true)
        const fromCwd: TraceCall = { kind: "call", name: "shell", args: JSON.stringify({ command: `./books check work/20260101-000001-get/${name}`, cwd: "books" }), result: "" }
        expect(run("trace.readBeforeSend", obs({ ...twins, timeline: [fromCwd, send] })).ok).toBe(true)
      })

      it("reads an inline script's paths from the folder its call changed into first", () => {
        const script = (folder: string) => shell(`cd ${folder} && python3 -c 'import zipfile; zipfile.ZipFile("20260101-000001-get/${name}").namelist()'`)
        expect(run("trace.readBeforeSend", obs({ ...twins, timeline: [script(work), send] })).ok).toBe(true)
        expect(run("trace.readBeforeSend", obs({ ...twins, timeline: [script("/tmp/elsewhere"), send] })).ok).toBe(false)
      })

      it("counts a wildcard inside an inline script as naming the files it covers", () => {
        const listing = shell(`cd ${work} && python3 -c 'import glob, zipfile; [zipfile.ZipFile(p).namelist() for p in glob.glob("*/*.epub")]'`)
        expect(run("trace.readBeforeSend", obs({ ...twins, timeline: [listing, send] })).ok).toBe(true)
      })

      it("counts a folder wildcard with no extension, such as a download folder's every file", () => {
        expect(run("trace.readBeforeSend", obs({ ...twins, timeline: [shell(`${books} check ${work}/20260101-000001-get/*`), send] })).ok).toBe(true)
        expect(run("trace.readBeforeSend", obs({ ...twins, timeline: [shell(`${books} check ${work}/20260101-000000-get/*`), send] })).ok).toBe(false)
      })

      it("credits every item of a loop over a quoted variable, the sent copy first or last", () => {
        const loop = (first: string, second: string) => shell(`cd books; for f in work/${first}/${name} work/${second}/${name}; do ./books check "$f"; done`)
        expect(run("trace.readBeforeSend", obs({ ...twins, timeline: [loop("20260101-000001-get", "20260101-000000-get"), send] })).ok).toBe(true)
        expect(run("trace.readBeforeSend", obs({ ...twins, timeline: [loop("20260101-000000-get", "20260101-000001-get"), send] })).ok).toBe(true)
        expect(run("trace.readBeforeSend", obs({ ...twins, timeline: [shell(`cd books; for f in work/20260101-000000-get/${name} work/x/${name}; do ./books check "$f"; done`), send] })).ok).toBe(false)
      })

      it("credits a loop variable inside a word, even in a call that also runs an inline script", () => {
        const cand = { mail: [{ to: POCKETBOOK, attachments: [sha("C")] }], created: [{ path: "books/work/cand/bbb.epub", sha256: sha("C") }] }
        const check = shell(`cd books; for m in aaa bbb; do ./books check work/cand/$m.epub; python3 -c 'print(1)'; done`)
        const sendIt = shell(`cd books && ./books send work/cand/bbb.epub`)
        expect(run("trace.readBeforeSend", obs({ ...cand, timeline: [check, sendIt] })).ok).toBe(true)
        const other = shell(`cd books; for m in aaa ccc; do ./books check work/cand/$m.epub; python3 -c 'print(1)'; done`)
        expect(run("trace.readBeforeSend", obs({ ...cand, timeline: [other, sendIt] })).ok).toBe(false)
      })

      it("does not count a file as read because the same call parses JSON with python3", () => {
        const cand = { mail: [{ to: POCKETBOOK, attachments: [sha("C")] }], created: [{ path: "books/work/cand/ccc.epub", sha256: sha("C") }] }
        const sendIt = shell(`cd books && ./books send work/cand/ccc.epub`)
        const json = `python3 -c 'import json,sys;print(json.load(sys.stdin)["file"])'`
        for (const copy of [
          `cd books; for m in aaa bbb ccc; do f=$(./books get --md5 $m | ${json}); cp "$f" work/cand/$m.epub; done`,
          `cd books; f=$(./books get --md5 ccc | ${json}); cp "$f" work/cand/ccc.epub`,
          `cd books; ls -la work/cand/ccc.epub; python3 -c 'print(1)'`,
        ]) expect(run("trace.readBeforeSend", obs({ ...cand, timeline: [shell(copy), sendIt] })).ok, copy).toBe(false)
      })

      it("finds a send whose output is piped through python3", () => {
        const cand = { mail: [{ to: POCKETBOOK, attachments: [sha("C")] }], created: [{ path: "books/work/cand/x.epub", sha256: sha("C") }] }
        const check = shell(`cd books; ./books check work/cand/x.epub`)
        const piped = shell(`cd books; F=work/cand/x.epub; ./books send "$F" | python3 -c 'import json,sys;print(json.load(sys.stdin)["ok"])'`)
        expect(run("trace.readBeforeSend", obs({ ...cand, timeline: [check, piped] })).ok).toBe(true)
        expect(run("trace.readBeforeSend", obs({ ...cand, timeline: [piped, check, shell(`cd books; ./books send work/cand/x.epub`)] })).ok).toBe(false)
      })

      it("credits a file a heredoc script opens, and a check inside a nested loop", () => {
        const cand = { mail: [{ to: POCKETBOOK, attachments: [sha("C")] }], created: [{ path: "books/work/cand/b3.epub", sha256: sha("C") }] }
        const sendIt = shell(`cd books && ./books send work/cand/b3.epub`)
        const heredoc = shell(`cd books && python3 - <<'EOF'\nimport zipfile\nprint(zipfile.ZipFile("work/cand/b3.epub").namelist())\nEOF`)
        expect(run("trace.readBeforeSend", obs({ ...cand, timeline: [heredoc, sendIt] })).ok).toBe(true)
        const nested = shell(`cd books; for a in a1 a2; do for b in b1 b2 b3; do ./books check work/cand/$b.epub; done; done`)
        expect(run("trace.readBeforeSend", obs({ ...cand, timeline: [nested, sendIt] })).ok).toBe(true)
      })

      it("passes a check of a quoted name with spaces in it", () => {
        const spaced = { mail: [{ to: POCKETBOOK, attachments: [sha("C")] }], created: [{ path: "books/work/The Harbour Almanac.epub", sha256: sha("C") }] }
        const timeline = [shell(`cd books && ./books check "work/The Harbour Almanac.epub" && ./books send "work/The Harbour Almanac.epub"`)]
        expect(run("trace.readBeforeSend", obs({ ...spaced, timeline })).ok).toBe(true)
      })
    })

    it("does not carry a variable from one shell call into the next", () => {
      const define = shell(`F=${work}/20260101-000000-get-2/harbour-almanac-c.epub; echo set`)
      const check = shell(`${books} check "$F"`)
      const send = shell(`${books} send ${work}/20260101-000000-get-2/harbour-almanac-c.epub`)
      expect(run("trace.readBeforeSend", obs({ ...sentFromWork, timeline: [define, check, send] })).ok).toBe(false)
    })
  })

  it("needs the read term and the file in the same command", () => {
    const timeline = [shell("ls books/work/harbour-almanac-c.epub; python3 -V"), shell("books deliver books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline })).ok).toBe(false)
  })

  it("ignores another tool that neither sends nor names a send", () => {
    const timeline = [{ kind: "call" as const, name: "read_file", args: "books/work/harbour-almanac-c.epub", result: "" },
      shell("books check books/work/harbour-almanac-c.epub"), shell("books deliver books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline })).ok).toBe(true)
  })

  it("fails an attachment no file created during the turn matches", () => {
    const check = run("trace.readBeforeSend", obs({ mail: [{ to: POCKETBOOK, attachments: [sha("C")] }], timeline: [] }))
    expect(check.ok).toBe(false)
    expect(check.detail).toContain("no file created")
  })

  it("passes vacuously when nothing was sent, leaving that to mail.sentAtLeastOne", () => {
    expect(run("trace.readBeforeSend", obs()).ok).toBe(true)
  })

  it("reads JSON arguments without a command as plain text", () => {
    const odd = (args: string) => ({ kind: "call" as const, name: "shell", args, result: "" })
    const timeline = [odd("null"), odd("{\"cmd\":1}"), shell("books deliver books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline })).ok).toBe(false)
  })

  it("reads plain-text shell arguments as the command", () => {
    const timeline = [{ kind: "call" as const, name: "shell", args: "books check books/work/harbour-almanac-c.epub", result: "" },
      shell("books deliver books/work/harbour-almanac-c.epub")]
    expect(run("trace.readBeforeSend", obs({ ...sent, timeline })).ok).toBe(true)
  })
})

describe("trace.never", () => {
  it("fails when any call's arguments match the pattern and passes otherwise", () => {
    const args = { pattern: "--accept-check-failure" }
    expect(run("trace.never", obs({ timeline: [shell("books deliver x.epub")] }), args).ok).toBe(true)
    const check = run("trace.never", obs({ timeline: [shell("books deliver --accept-check-failure x.epub")] }), args)
    expect(check.ok).toBe(false)
    expect(check.detail).toContain("shell")
  })

  it("ignores reply text", () => {
    expect(run("trace.never", obs({ timeline: [{ kind: "reply", text: "--accept-check-failure" }] }), { pattern: "--accept-check-failure" }).ok).toBe(true)
  })

  // 2026-11-23, eval replay: a run that never used the flag wrote the household's rule "never use
  // `--accept-check-failure`" into its notes, and the check failed it for the note's text.
  const call = (name: string, args: Record<string, unknown>): TraceCall => ({ kind: "call", name, args: JSON.stringify(args), result: "ok" })
  const RULE = "- open and read a book before it is sent. Never send a copy whose check failed, and never use `--accept-check-failure` unless he says to."
  it("passes when the flag is only written about: in notes, file edits, echoed text or a heredoc's body", () => {
    const args = { pattern: "--accept-check-failure" }
    for (const timeline of [
      [call("edit_file", { path: "/home/ouro/bundle/psyche/TACIT.md", old_string: "I add to this as I learn.", new_string: `I add to this as I learn.\n\n## books\n\n${RULE}` })],
      [call("note", { content: `## books\n\n${RULE}` })],
      [call("write_file", { path: "/home/ouro/bundle/desk/notes/books.md", content: `# Books\n\n${RULE}` })],
      [shell(`echo "${RULE.replace(/`/g, "")}" >> /home/ouro/bundle/desk/notes/books.md`)],
      [shell(`cat >> /home/ouro/bundle/desk/notes/books.md <<'EOF'\n${RULE}\n--accept-check-failure is only for a copy he names\nEOF\nbooks library find "The Harbour Almanac"`)],
      [shell("grep -n -- '--accept-check-failure is' /home/ouro/bundle/skills/book-delivery.md")],
    ]) expect(run("trace.never", obs({ timeline }), args), timeline[0]!.args).toMatchObject({ ok: true })
  })

  it("still fails a command that passes the flag, however it is written", () => {
    const args = { pattern: "--accept-check-failure" }
    for (const command of [
      "/home/ouro/bundle/books/books send --accept-check-failure /home/ouro/bundle/books/work/a/harbour-almanac.epub",
      "B=/home/ouro/bundle/books/books; $B deliver \"--accept-check-failure\" work/x.epub",
      "books deliver --accept-check-failure=yes work/x.epub",
      "cd ~/bundle && books send --accept-check-failure work/x.epub <<'EOF'\nok\nEOF",
      "python3 -c 'import subprocess; subprocess.run([\"books\", \"send\", \"--accept-check-failure\", \"x.epub\"])'",
      "python3 <<'PY'\nimport subprocess\nsubprocess.run(['books', 'send', '--accept-check-failure', 'x.epub'])\nPY",
    ]) {
      const check = run("trace.never", obs({ timeline: [call("note", { content: RULE }), shell(command)] }), args)
      expect(check, command).toMatchObject({ ok: false, detail: "matching calls: shell" })
    }
  })
})

describe("library.lacks", () => {
  it("passes when the id is gone and fails while it is still shelved", () => {
    expect(run("library.lacks", obs({ library: [] }), { id: 187 }).ok).toBe(true)
    expect(run("library.lacks", obs(), { id: 187 }).ok).toBe(false)
  })

  it("throws when the id is not a number", () => {
    expect(() => run("library.lacks", obs(), { id: "187" })).toThrow("library.lacks needs args.id")
  })
})

describe("library.holdsWork", () => {
  it("passes when a labelled readable copy of the work is shelved", () => {
    const library = [...seed().library, { id: 189, title: "The Harbour Almanac", sha256: sha("C") }]
    expect(run("library.holdsWork", obs({ library }), { work: "harbour-almanac" }).ok).toBe(true)
  })

  it("fails on an unreadable copy, another work, or an ungraded file", () => {
    expect(run("library.holdsWork", obs(), { work: "harbour-almanac" }).ok).toBe(false)
    const guide = [{ id: 190, title: "Study Guide", sha256: sha("D") }]
    expect(run("library.holdsWork", obs({ library: guide }), { work: "harbour-almanac" }).ok).toBe(false)
    expect(run("library.holdsWork", obs({ library: [{ id: 191, title: "x", sha256: sha("rebuilt") }] }), { work: "harbour-almanac" }).ok).toBe(false)
  })

  it("judges an unlabelled copy by the oracle, as mail does, and marks its work unverified", () => {
    const rebuilt = sha("rebuilt")
    const library = [{ id: 191, title: "x", sha256: rebuilt }]
    const readable = run("library.holdsWork", obs({ library, oracle: { [rebuilt]: true } }), { work: "harbour-almanac" })
    expect(readable.ok).toBe(true)
    expect(readable.detail).toContain("unlabelled")
    expect(readable.detail).toContain("work unverified")
    expect(run("library.holdsWork", obs({ library, oracle: { [rebuilt]: false } }), { work: "harbour-almanac" }).ok).toBe(false)
  })
})

describe("library.othersUnchanged", () => {
  it("passes when every seeded book outside the exceptions is still there unchanged", () => {
    expect(run("library.othersUnchanged", obs({ library: [seed().library[1]!] }), { except: [187] }).ok).toBe(true)
  })

  it("fails when another book is removed or its bytes change", () => {
    const removed = run("library.othersUnchanged", obs({ library: [] }), { except: [187] })
    expect(removed.ok).toBe(false)
    expect(removed.detail).toContain("140")
    const changed = run("library.othersUnchanged", obs({ library: [{ id: 140, title: "Tidewater Recipes", sha256: sha("other") }] }), { except: [187] })
    expect(changed.ok).toBe(false)
  })

  it("treats a missing except list as none and throws on a malformed one", () => {
    expect(run("library.othersUnchanged", obs({ library: [seed().library[1]!] })).ok).toBe(false)
    expect(() => run("library.othersUnchanged", obs(), { except: ["187"] })).toThrow("args.except")
  })
})

describe("library.noNewCopiesOf", () => {
  const args = { editions: ["A", "D"] }

  it("passes when no new shelf entry is one of the editions", () => {
    const library = [...seed().library, { id: 189, title: "The Harbour Almanac", sha256: sha("C") }]
    expect(run("library.noNewCopiesOf", obs({ library }), args).ok).toBe(true)
  })

  it("fails a newly added banned edition, including a re-add of a seeded one under a new id", () => {
    const guide = [...seed().library, { id: 190, title: "Study Guide", sha256: sha("D") }]
    const check = run("library.noNewCopiesOf", obs({ library: guide }), args)
    expect(check.ok).toBe(false)
    expect(check.detail).toContain("190")
    const readd = [...seed().library, { id: 191, title: "The Harbour Almanac", sha256: sha("A") }]
    expect(run("library.noNewCopiesOf", obs({ library: readd }), args).ok).toBe(false)
  })

  it("ignores new unlabelled files and throws on malformed editions", () => {
    const library = [...seed().library, { id: 192, title: "x", sha256: sha("rebuilt") }]
    expect(run("library.noNewCopiesOf", obs({ library }), args).ok).toBe(true)
    expect(() => run("library.noNewCopiesOf", obs(), { editions: "A" })).toThrow("args.editions")
  })
})

describe("disk.createdBytesOf", () => {
  it("passes when a file created during the turn holds the book's bytes", () => {
    const check = run("disk.createdBytesOf", obs({ created: [{ path: "books/removed/187.epub", sha256: sha("A") }] }), { bookId: 187 })
    expect(check.ok).toBe(true)
    expect(check.detail).toContain("books/removed/187.epub")
  })

  it("fails with no backup, a backup of other bytes, or an unknown book", () => {
    expect(run("disk.createdBytesOf", obs(), { bookId: 187 }).ok).toBe(false)
    expect(run("disk.createdBytesOf", obs({ created: [{ path: "x.epub", sha256: sha("C") }] }), { bookId: 187 }).ok).toBe(false)
    expect(run("disk.createdBytesOf", obs(), { bookId: 999 }).detail).toContain("999")
  })

  it("fails when the only matching hash was already on disk in the seed", () => {
    const check = run("disk.createdBytesOf", obs({ created: [{ path: "books/removed/187.epub", sha256: sha("A") }] }), { bookId: 187 }, seed({ disk: [sha("A")] }))
    expect(check.ok).toBe(false)
    expect(check.detail).toContain("seed")
  })
})

describe("mail.none", () => {
  it("passes with no mail and fails with any", () => {
    expect(run("mail.none", obs()).ok).toBe(true)
    expect(run("mail.none", obs({ mail: [{ to: POCKETBOOK, attachments: [] }] })).ok).toBe(false)
  })
})

describe("reply.namesShelf", () => {
  const args = { titles: ["The Harbour Almanac"], ids: [189] }

  it("passes when the reply names a title or an id", () => {
    expect(run("reply.namesShelf", obs({ finalReply: "the harbour almanac is shelved" }), args).ok).toBe(true)
    expect(run("reply.namesShelf", obs({ finalReply: "Kept book 189." }), args).ok).toBe(true)
  })

  it("fails when it names neither, and does not match an id inside a longer number", () => {
    expect(run("reply.namesShelf", obs({ finalReply: "Done." }), args).ok).toBe(false)
    expect(run("reply.namesShelf", obs({ finalReply: "Kept book 1890." }), args).ok).toBe(false)
  })

  it("throws on malformed arguments", () => {
    expect(() => run("reply.namesShelf", obs(), { titles: [1], ids: [] })).toThrow("args.titles")
    expect(() => run("reply.namesShelf", obs(), { titles: [], ids: ["189"] })).toThrow("args.ids")
  })
})

describe("reply.noHedgeAbout", () => {
  const args = { topic: "remov|delet|shelf|library" }

  it("passes a hedge that is not about the asked action", () => {
    const finalReply = "I couldn't find a better edition, but the old one is gone and the Harbour Almanac (189) is on the shelf"
    expect(run("reply.noHedgeAbout", obs({ finalReply }), args).ok).toBe(true)
    expect(run("reply.noHedgeAbout", obs({ finalReply: "I can't download that one. The old copy is removed." }), args).ok).toBe(true)
  })

  it("fails a claimed inability or a hedge in a sentence about the action", () => {
    const check = run("reply.noHedgeAbout", obs({ finalReply: "I can't remove it yet" }), args)
    expect(check.ok).toBe(false)
    expect(check.detail).toContain("can't remove")
    expect(run("reply.noHedgeAbout", obs({ finalReply: "Done!\nI don't have permission to delete books." }), args).ok).toBe(false)
    expect(run("reply.noHedgeAbout", obs({ finalReply: "Removing it is beyond what I'm unable to do." }), args).ok).toBe(false)
    expect(run("reply.noHedgeAbout", obs({ finalReply: "The library cannot be changed." }), args).ok).toBe(false)
  })

  it("throws without a topic", () => {
    expect(() => run("reply.noHedgeAbout", obs(), {})).toThrow("args.topic")
  })
})

describe("findHedges", () => {
  it("returns each hedge with about twenty characters of context", () => {
    expect(findHedges("That would be illegal in my view.", REPLY_HEDGE_TERMS)).toEqual(["That would be illegal in my view."])
    expect(findHedges("", REPLY_HEDGE_TERMS)).toEqual([])
    expect(findHedges(null as unknown as string, REPLY_HEDGE_TERMS)).toEqual([])
  })

  it("keeps a term's global flag rather than adding another", () => {
    expect(findHedges("risk and risky", [/risk/gi])).toHaveLength(2)
  })
})

describe("evaluate", () => {
  const testCase = (assertions: Case["assertions"]): Case => ({
    schemaVersion: 1, id: "remove-bad-copy", actionIds: [], bundle: { include: [] }, prefix: [], seed: seed(),
    assertions, fixtures: { pass: obs(), fail: { any: obs() } },
  })

  it("passes only when every named assertion passes, and returns each check", () => {
    const passing = evaluate(testCase([{ name: "mail.none" }, { name: "library.lacks", args: { id: 999 } }]), obs())
    expect(passing.passed).toBe(true)
    expect(passing.checks.map(check => check.name)).toEqual(["mail.none", "library.lacks"])
    const failing = evaluate(testCase([{ name: "mail.none" }, { name: "library.lacks", args: { id: 187 } }]), obs())
    expect(failing.passed).toBe(false)
  })

  it.each(["trace-mismatch", "sandbox-error: the turn did not finish within 50 ms"])("fails a run whose outcome is %s, whatever else held", (outcome) => {
    const graded = evaluate(testCase([{ name: "mail.none" }]), obs({ outcome }))
    expect(graded.passed).toBe(false)
    expect(graded.checks).toEqual([{ name: "mail.none", ok: true, detail: expect.any(String) }, { name: "run.trusted", ok: false, detail: `the run cannot be graded: ${outcome}` }])
  })

  it("does not add the trusted-run check to a run that settled or hit the harness's own limits", () => {
    for (const outcome of ["settled", "step-limit"]) expect(evaluate(testCase([{ name: "mail.none" }]), obs({ outcome })).checks.map(check => check.name)).toEqual(["mail.none"])
  })

  it("throws on an assertion name not in the vocabulary, including inherited object keys", () => {
    expect(() => evaluate(testCase([{ name: "mail.maybe" }]), obs())).toThrow("Unknown assertion: mail.maybe")
    expect(() => evaluate(testCase([{ name: "toString" }]), obs())).toThrow("Unknown assertion: toString")
  })
})
