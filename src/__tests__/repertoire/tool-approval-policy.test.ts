import { describe, expect, it } from "vitest"

import { approvalPolicyForToolName } from "../../repertoire/tools"

describe("explicit tool approval policy", () => {
  it.each([
    [{}, "missing command"],
    [{ command: 7 }, "non-string command"],
    [{ command: "" }, "empty command"],
    [{ command: "docker" }, "docker without verb"],
    [{ command: "docker restart" }, "restart without target"],
    [{ command: "docker stop calibre-web" }, "different lifecycle verb"],
    [{ command: "printf ok" }, "unrelated shell command"],
  ])("does not protect %s (%s)", (args) => {
    expect(approvalPolicyForToolName("shell", args)).toEqual({ kind: "not_required" })
  })

  it("protects normalized Docker restart commands independently of risk", () => {
    expect(approvalPolicyForToolName("shell", { command: "  docker   restart   calibre-web  " })).toEqual({
      kind: "required",
      policyId: "shell.docker-lifecycle.v1",
      actionClass: "service-control",
      requiresSoleCall: true,
    })
  })

  it("defaults unknown tools to no approval policy", () => {
    expect(approvalPolicyForToolName("not_registered", {})).toEqual({ kind: "not_required" })
  })
})
