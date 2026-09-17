import { describe, expect, it } from "vitest"
import { SANCTUARY_UNIT_16_EVIDENCE_LABELS, validateSanctuaryUnit16EvidenceAssertions } from "../../../heart/daemon/sanctuary-acceptance-harness"

describe("retired historical runtime-vault containment assertion", () => {
  it("keeps physical containment at 16e and gives 16b only runtime/vault readiness", () => {
    expect(SANCTUARY_UNIT_16_EVIDENCE_LABELS).not.toContain("unit-16b-runtime-vault-containment")
    expect(SANCTUARY_UNIT_16_EVIDENCE_LABELS).toContain("unit-16b-runtime-vault-readiness")
    expect(() => validateSanctuaryUnit16EvidenceAssertions("unit-16b-runtime-vault-containment" as never, {})).toThrow()
    expect(validateSanctuaryUnit16EvidenceAssertions("unit-16b-runtime-vault-readiness" as never, {
      autostartExact: true, exactImage: true, manualAuthRequired: false, updaterDisabled: true, vaultUnlocked: true,
    })).toEqual({ autostartExact: true, exactImage: true, manualAuthRequired: false, updaterDisabled: true, vaultUnlocked: true })
    expect(() => validateSanctuaryUnit16EvidenceAssertions("unit-16b-runtime-vault-readiness" as never, {
      autostartExact: true, exactImage: true, manualAuthRequired: false, updaterDisabled: true, vaultUnlocked: true, readOnlyRoot: true, mountCount: 4,
    })).toThrow()
  })
})
