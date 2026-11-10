import { describe, expect, it } from "vitest"
import * as path from "path"

const bench = require(path.resolve(__dirname, "../../../.github/scripts/edge-benchmark.cjs"))

describe("edge-benchmark", () => {
  it("parses run and report flags, numbers as numbers", () => {
    expect(bench.parseArgs(["run", "--tarball", "x.tgz", "--out", "o.json", "--idle-seconds", "7", "--memory-cap-mib", "1024"])).toMatchObject({
      command: "run",
      tarball: "x.tgz",
      out: "o.json",
      idleSeconds: 7,
      runs: 5,
      memoryCapMib: "1024",
    })
    expect(() => bench.parseArgs(["run", "--out"])).toThrow("--out needs a value")
    expect(() => bench.parseArgs(["run", "stray"])).toThrow("unexpected argument")
  })

  it("takes the median of finite values", () => {
    expect(bench.median([5, 1, 3])).toBe(3)
    expect(bench.median([4, 1, 3, 2])).toBe(3)
    expect(bench.median([Number.NaN])).toBeNull()
  })

  it("reads ps output and walks a process tree, root first", () => {
    const table = bench.parsePsTable([
      "  10     1  1000 /usr/bin/node /x/dist/heart/daemon/daemon-entry.js --socket /tmp/s",
      "  11    10  2000 /usr/bin/node /x/dist/heart/agent-entry.js --agent a",
      "  12    11   300 /usr/bin/git status",
      "  13     1   400 /usr/bin/other",
      "garbage",
    ].join("\n"))
    expect(table.size).toBe(4)
    expect(bench.treePids(table, 10)).toEqual([10, 11, 12])
    expect(bench.treePids(table, 99)).toEqual([])
    expect(bench.processRole(table.get(11).args)).toBe("agent-entry.js")
    expect(bench.processRole(table.get(12).args)).toBe("git")
  })

  it("reads kB fields from /proc text", () => {
    const text = "Rss:    1234 kB\nPss:     567 kB\nRssAnon:\t 89 kB\n"
    expect(bench.procField(text, "Pss")).toBe(567)
    expect(bench.procField(text, "RssAnon")).toBe(89)
    expect(bench.procField(text, "Swap")).toBeNull()
  })

  it("keeps each pid's latest snapshot, optionally of one kind", () => {
    const lines = [
      JSON.stringify({ pid: 1, when: "t5", modules: 10 }),
      JSON.stringify({ pid: 1, when: "exit", modules: 12 }),
      "not json",
      JSON.stringify({ pid: 2, when: "t5", modules: 7 }),
      "",
    ]
    expect(bench.latestSnapshots(lines).map((r: { modules: number }) => r.modules)).toEqual([12, 7])
    expect(bench.latestSnapshots(lines, "exit").map((r: { pid: number }) => r.pid)).toEqual([1])
  })

  it("lists the heaviest packages first", () => {
    expect(bench.topPackages({ a: 1, stripe: 185, openai: 115, b: 1 }, 3)).toEqual([
      { name: "stripe", modules: 185 },
      { name: "openai", modules: 115 },
      { name: "a", modules: 1 },
    ])
    expect(bench.topPackages(undefined)).toEqual([])
  })

  it("formats values by unit", () => {
    expect(bench.formatValue(null, "ms")).toBe("—")
    expect(bench.formatValue(2 * 1024 * 1024, "bytes")).toBe("2.0 MiB")
    expect(bench.formatValue(10240, "kB")).toBe("10.0 MiB")
    expect(bench.formatValue(950, "ms")).toBe("950 ms")
    expect(bench.formatValue(12_345, "ms")).toBe("12.3 s")
    expect(bench.formatValue(42, "count")).toBe("42")
  })

  it("compares a run with its baseline and marks what moved", () => {
    const baseline = { cli: { modules: 1483, wallMs: 1000 }, daemon: { idleRssKb: 100_000 } }
    const current = {
      host: { platform: "linux", arch: "arm64", node: "22.23.4", cpus: 4, cpuModel: "A53", totalMemBytes: 1024 ** 3, memoryCapMiB: 1024 },
      package: { version: "0.1.0-alpha.998", source: "packed" },
      cli: { modules: 400, wallMs: 1000, topPackages: [{ name: "(own)", modules: 380 }] },
      daemon: { idleRssKb: 110_000 },
      errors: ["stack: boom"],
    }
    const rows = bench.compare(current, baseline)
    const row = (key: string) => rows.find((r: { key: string }) => r.key === key)
    expect(row("cli.modules").delta).toBeCloseTo(400 / 1483 - 1)
    expect(row("daemon.idleRssKb").delta).toBeCloseTo(0.1)
    expect(row("turn.settledMs").current).toBeNull()

    const markdown = bench.renderReport(current, baseline, "main (run 1)")
    expect(markdown).toContain("linux-arm64, 1024 MiB memory cap")
    expect(markdown).toContain("Compared with main (run 1).")
    expect(markdown).toMatch(/modules loaded \| 400 \| 1483 \| \*\*-73\.0%\*\* 🟢/)
    expect(markdown).toContain("+10.0% 🔺")
    expect(markdown).toContain("±0%")
    expect(markdown).toContain("(own) 380")
    expect(markdown).toContain("- stack: boom")
    expect(bench.renderReport({ host: {} }, null)).toContain("No baseline yet.")
  })

  it("names every metric once, lower is better", () => {
    const keys = bench.METRICS.map((metric: string[]) => metric[0])
    expect(new Set(keys).size).toBe(keys.length)
    expect(bench.metricValue({ a: { b: 3 } }, "a.b")).toBe(3)
    expect(bench.metricValue({ a: { b: "3" } }, "a.b")).toBeNull()
  })
})
