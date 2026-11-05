const safeOwner = (agent: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agent)
const claimId = (id: string): boolean => /^[a-f0-9]{64}$/.test(id)

/** Display-only local commands; no browser action or observation is an authorization grant. */
export function shepherdInspectionCommand(agent: string, id?: string): string | null {
  if (!safeOwner(agent) || (id !== undefined && !claimId(id))) return null
  return id === undefined
    ? `ouro shepherd status --agent '${agent}' --json`
    : `ouro shepherd inspect --agent '${agent}' --id '${id}' --json`
}

export function shepherdRetirementCommand(agent: string, id: string, revision: number | null): string | null {
  if (!safeOwner(agent) || !claimId(id) || revision === null || !Number.isSafeInteger(revision) || revision < 0) return null
  return `ouro shepherd reconcile --agent '${agent}' --id '${id}' --resolution retired --expected-revision ${revision} --request-id 'supervision-retire-${id}-r${revision}' --json`
}
