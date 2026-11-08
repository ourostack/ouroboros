import { describe, expect, it } from "vitest"
import * as path from "path"

const { assignShards, checkShardLists, weightsFromLog } = require(path.resolve(__dirname, "../../../.github/scripts/coverage-shards.cjs"))

describe("coverage-shards", () => {
  it("puts every file on exactly one shard and balances by weight", () => {
    const weights = { "a.test.ts": 200, "b.test.ts": 80, "c.test.ts": 60, "d.test.ts": 60, "e.test.ts": 40, "f.test.ts": 40 }
    const shards = assignShards(Object.keys(weights), weights, 2)
    expect(shards.flatMap((shard: { files: string[] }) => shard.files).sort()).toEqual(Object.keys(weights).sort())
    expect(shards.map((shard: { load: number }) => shard.load)).toEqual([240, 240])
  })

  it("gives the same split for the same files in any order", () => {
    const weights = { "a.test.ts": 3, "b.test.ts": 3, "c.test.ts": 2, "d.test.ts": 1 }
    const files = Object.keys(weights)
    expect(assignShards([...files].reverse(), weights, 3)).toEqual(assignShards(files, weights, 3))
  })

  it("weighs a file it has no measurement for at the median", () => {
    const shards = assignShards(["a.test.ts", "b.test.ts", "c.test.ts", "new.test.ts"], { "a.test.ts": 1, "b.test.ts": 5, "c.test.ts": 9 }, 2)
    expect(shards.map((shard: { load: number }) => shard.load).sort()).toEqual([10, 10])
    expect(assignShards(["x.test.ts"], {}, 2).map((shard: { files: string[] }) => shard.files)).toEqual([["x.test.ts"], []])
  })

  it("accepts shards that ran every file exactly once", () => {
    const all = ["a", "b", "c"]
    const lists = [
      { index: 2, count: 2, all, assigned: ["c"] },
      { index: 1, count: 2, all: [...all].reverse(), assigned: ["a", "b"] },
    ]
    expect(checkShardLists(lists, 2)).toEqual([])
  })

  it("reports a missing shard, a missed file, a file run twice and a different file list", () => {
    const all = ["a", "b", "c"]
    expect(checkShardLists([{ index: 1, count: 2, all, assigned: ["a", "b", "c"] }], 2)).toEqual(["expected shards 1,2, got 1"])
    expect(checkShardLists([], 1)).toEqual(["expected shards 1, got none"])
    expect(checkShardLists([
      { index: 1, count: 2, all, assigned: ["a", "b"] },
      { index: 2, count: 3, all: ["a", "b", "c", "d"], assigned: ["b", "x"] },
    ], 2)).toEqual([
      "shard 2 ran as 2/3, expected /2",
      "shard 2 saw a different test file list",
      "b ran on shards 1 and 2",
      "c ran on no shard",
      "x ran but is not in the test file list",
    ])
  })

  it("reads per-file wall time from a CI log, skipping the mailbox-ui run", () => {
    const log = [
      "2026-11-07T21:10:22.0000000Z \x1b[46m RUN \x1b[49m v4.1.11 /work/packages/mailbox-ui",
      "2026-11-07T21:10:23.0000000Z  ✓ src/ignored.test.ts (1 test) 5ms",
      "2026-11-07T21:10:25.0000000Z  RUN  v4.1.12 /work",
      "2026-11-07T21:10:31.5000000Z  \x1b[32m✓\x1b[39m src/__tests__/b.test.ts (4 tests) 4481ms",
      "2026-11-07T21:10:31.6000000Z      ✓ a slow case  567ms",
      "2026-11-07T21:10:39.0000000Z  ↓ src/__tests__/a.test.ts (2 tests | 2 skipped)",
      "2026-11-07T21:10:40.0000000Z  ✓ src/__tests__/b.test.ts (4 tests) 1ms",
    ].join("\n")
    expect(weightsFromLog(log)).toEqual({ "src/__tests__/a.test.ts": 7.5, "src/__tests__/b.test.ts": 6.5 })
  })
})
