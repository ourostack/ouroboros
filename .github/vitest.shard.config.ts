// Vitest config for one CI coverage shard (`--shard=i/N --reporter=blob`).
// It is vitest.config.ts with two changes:
//   1. a sequencer that splits files by measured duration (see
//      .github/scripts/coverage-shards.cjs) and records its split;
//   2. no coverage thresholds, because one shard covers only part of src. The
//      merge job checks the real thresholds on the merged coverage.
import { writeFileSync } from "fs"
import path from "path"
import { mergeConfig } from "vitest/config"
import { BaseSequencer, type TestSpecification } from "vitest/node"

import base from "../vitest.config"

const root = path.resolve(__dirname, "..")
const { assignShards } = require("./scripts/coverage-shards.cjs")
const weights = require("./coverage-shard-weights.json")

class WeightedShardSequencer extends BaseSequencer {
  async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!
    const relative = (spec: TestSpecification) => path.relative(root, spec.moduleId).split(path.sep).join("/")
    const all = files.map(relative)
    const assigned: string[] = assignShards(all, weights, count)[index - 1].files
    const listPath = process.env.COVERAGE_SHARD_LIST
    if (listPath) writeFileSync(listPath, JSON.stringify({ index, count, all, assigned }, null, 1))
    const keep = new Set(assigned)
    return files.filter((spec) => keep.has(relative(spec)))
  }
}

const config = mergeConfig(base, {
  test: {
    sequence: { sequencer: WeightedShardSequencer },
    coverage: { thresholds: { lines: 0, branches: 0, functions: 0, statements: 0 } },
  },
})
// Set after merging: mergeConfig would append to the base reporter list.
config.test!.coverage!.reporter = ["json-summary"]

export default config
