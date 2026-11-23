import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

describe("container publish native build", () => {
  it("builds native dependencies against the installed Node's headers and fails when they are missing", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/container-publish.yml"), "utf8")
    expect(workflow).toContain('test -f "$NODEDIR/include/node/node.h"')
    expect(workflow).toContain('npm ci --nodedir="$NODEDIR"')
    expect(workflow).not.toMatch(/^\s*npm ci\s*$/m)
  })

  it("finds the headers where the workflow looks for them on the Node that setup-node installs", () => {
    const nodeDir = dirname(dirname(process.execPath))
    expect(existsSync(join(nodeDir, "include/node/node.h"))).toBe(true)
  })
})
