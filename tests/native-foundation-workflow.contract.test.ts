import { readFileSync } from "fs"
import { join } from "path"
import { describe, expect, it } from "vitest"

const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "native-foundation.yml"), "utf8")

describe("native foundation workflow contract", () => {
  it("builds one byte-reproducible universal helper and publishes its hash-bound artifact", () => {
    expect(workflow).toContain("native/process-proof/process-proof-darwin.c")
    expect(workflow).toContain("-arch arm64")
    expect(workflow).toContain("-arch x86_64")
    expect(workflow).toContain("cmp native-foundation/process-proof-arm64 native-foundation/repeat/process-proof-arm64")
    expect(workflow).toContain("cmp native-foundation/process-proof-x86_64 native-foundation/repeat/process-proof-x86_64")
    expect(workflow).toContain("xcrun lipo -create")
    expect(workflow).toContain("-verify_arch arm64 x86_64")
    expect(workflow).toContain("process-proof-darwin-${{ github.sha }}")
    expect(workflow).toContain("process-proof-darwin.sha256")
    expect(workflow).toContain("cmp native-foundation/process-proof-darwin assets/native/process-proof/process-proof-darwin")
    expect(workflow).toContain("shasum -a 256 -c process-proof-darwin.sha256")
  })

  it("executes and measures the matching slice on both required hosted architectures", () => {
    expect(workflow).toContain("runner: macos-26\n            arch: arm64")
    expect(workflow).toContain("runner: macos-26-intel\n            arch: x86_64")
    expect(workflow).toContain("test \"$(uname -m)\" = \"${{ matrix.arch }}\"")
    expect(workflow).toContain("tests/native/process-proof.test.ts")
    expect(workflow).toContain("tests/native/process-proof-coverage-driver.c")
    expect(workflow).toContain("-fprofile-instr-generate -fcoverage-mapping")
    expect(workflow).toContain("-ignore-filename-regex='tests/native/process-proof-coverage-driver.c'")
    expect(workflow).toContain("if (totals[key].percent !== 100)")
  })
})
