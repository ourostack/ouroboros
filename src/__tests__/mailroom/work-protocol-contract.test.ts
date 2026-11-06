import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import {
  describeMailProvenance,
  type MailProvenanceDescriptor,
  type StoredMailMessage,
} from "../../mailroom/core"

type MailProvenanceContractCase = {
  name: string
  message: Pick<StoredMailMessage, "agentId" | "compartmentKind" | "ownerEmail" | "source" | "recipient">
  expected: MailProvenanceDescriptor
}

type MailProvenanceContract = {
  contract: "mail-provenance"
  version: 1
  canonicalPackage: "@ouro/work-protocol"
  cases: MailProvenanceContractCase[]
}

function readContract(filePath: string): MailProvenanceContract {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as MailProvenanceContract
}

function vendoredContractPath(): string {
  return path.resolve(__dirname, "../../mailroom/contracts/work-protocol-mail-provenance.v1.json")
}

function localSubstrateContractPath(): string | null {
  const roots = [
    process.env.OURO_WORK_SUBSTRATE_DIR,
    path.resolve(process.cwd(), "..", "ouro-work-substrate"),
    path.resolve(process.cwd(), "..", "..", "ouro-work-substrate"),
  ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0)

  for (const root of roots) {
    const candidate = path.join(root, "packages/work-protocol/contracts/mail-provenance.v1.json")
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

describe("work-protocol mail provenance contract", () => {
  it("keeps the harness descriptor aligned with the vendored work-protocol contract", () => {
    const contract = readContract(vendoredContractPath())

    expect(contract).toEqual(expect.objectContaining({
      contract: "mail-provenance",
      version: 1,
      canonicalPackage: "@ouro/work-protocol",
    }))
    expect(contract.cases.map((entry) => ({
      name: entry.name,
      actual: describeMailProvenance(entry.message),
    }))).toEqual(contract.cases.map((entry) => ({
      name: entry.name,
      actual: entry.expected,
    })))
  })

  it("matches the local ouro-work-substrate canonical contract when that checkout is present", () => {
    const substrateContractPath = localSubstrateContractPath()
    const vendored = readContract(vendoredContractPath())

    if (!substrateContractPath) {
      expect(vendored.canonicalPackage).toBe("@ouro/work-protocol")
      return
    }

    expect(readContract(substrateContractPath)).toEqual(vendored)
  })
})
