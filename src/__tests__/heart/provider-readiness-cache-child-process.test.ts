import { describe, expect, it } from "vitest"
import type { AgentProvider } from "../../heart/identity"
import type { ProviderLane } from "../../heart/provider-lanes"
import { readProviderLaneReadiness } from "../../heart/provider-readiness-cache"

const hasParentFixture = Boolean(process.env.PROVIDER_READINESS_AGENT_ROOT)
const fixtureIt = hasParentFixture ? it : it.skip

describe("provider readiness cache child process helper", () => {
  fixtureIt("reads readiness persisted by the parent process", () => {
    const agentRoot = process.env.PROVIDER_READINESS_AGENT_ROOT
    expect(agentRoot).toBeTruthy()
    const entry = readProviderLaneReadiness({
      ...(agentRoot ? { agentRoot } : {}),
      agentName: process.env.PROVIDER_READINESS_AGENT_NAME ?? "",
      lane: process.env.PROVIDER_READINESS_LANE as ProviderLane,
      provider: process.env.PROVIDER_READINESS_PROVIDER as AgentProvider,
      model: process.env.PROVIDER_READINESS_MODEL ?? "",
      credentialRevision: process.env.PROVIDER_READINESS_CREDENTIAL_REVISION ?? "",
    })

    expect(entry).toMatchObject({
      status: process.env.PROVIDER_READINESS_STATUS,
      attempts: Number(process.env.PROVIDER_READINESS_ATTEMPTS),
      error: process.env.PROVIDER_READINESS_ERROR,
    })
  })
})
