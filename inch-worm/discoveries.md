## [D-001] — `ouro up` does not ping selected providers

**Source**: observed-during-seed
**What**: `ouro up` reports startup as healthy after structural config checks even when a selected provider token is expired or the provider ping would fail.
**Where**: `src/heart/daemon/process-manager.ts`, `src/heart/daemon/agent-config-check.ts`, `src/heart/provider-ping.ts`
**Why it matters**: Users get an "all okay" startup followed by turn-time authentication errors, which makes the repair path feel random and late.
**Evidence**: Running `ouro up` previously passed while the next Slugger turn surfaced provider authentication failures; code inspection showed the startup config check only verified required credential fields, not live selected-provider reachability.
**Severity**: high-value
**Blast radius**: affects multiple modules
**Fix shape**: Add a bounded live provider verification step for unique selected facings during startup health/config checks, with clear degraded status and repair guidance.
**Status**: fixed
**Linked work**: https://github.com/ouroborosbot/ouroboros/pull/439

---
