// ADO context helper -- shared by all semantic ADO tools.
// Extracts org/project from model-provided args or runs discovery cascade.
// Re-discovery on 403 naturally handled: scope discovery APIs reflect current access.

import { discoverOrganizations, discoverProjects } from "./ado-client"
import type { ResolvedContext } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"

export interface AdoContextOk {
  ok: true
  organization: string
  project: string
}

export interface AdoContextError {
  ok: false
  error: string
}

export type AdoContextResult = AdoContextOk | AdoContextError

interface AdoContextArgs {
  organization?: string
  project?: string
}

/**
 * Resolve ADO organization and project for a semantic tool.
 * If org/project are provided by the model, use them directly.
 * Otherwise, run discovery cascade: discover orgs, auto-select if single,
 * then discover projects, auto-select if single.
 *
 * @param token - ADO OAuth token
 * @param context - ResolvedContext from the context kernel
 * @param args - optional org/project from the model
 */
export async function resolveAdoContext(
  token: string,
  context: ResolvedContext,
  args?: AdoContextArgs,
): Promise<AdoContextResult> {
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.ado_context_resolve",
    message: "resolving ado context",
    meta: {},
  })
  // Reject if ADO integration is not available
  if (!context.channel.availableIntegrations.includes("ado")) {
    return { ok: false, error: "ADO integration is not available in this channel." }
  }

  try {
    // Resolve organization
    let org = args?.organization
    if (!org) {
      const orgs = await discoverOrganizations(token)
      if (orgs.length === 0) {
        return { ok: false, error: "No ADO organizations found for this user." }
      }
      if (orgs.length === 1) {
        org = orgs[0]
      } else {
        return {
          ok: false,
          error: `Multiple ADO organizations found. Please specify which one:\n${orgs.map(o => `- ${o}`).join("\n")}`,
        }
      }
    }

    // Resolve project
    let project = args?.project
    if (!project) {
      const projects = await discoverProjects(token, org)
      if (projects.length === 0) {
        return { ok: false, error: `No projects found in organization "${org}".` }
      }
      if (projects.length === 1) {
        project = projects[0]
      } else {
        return {
          ok: false,
          error: `Multiple projects found in "${org}". Please specify which one:\n${projects.map(p => `- ${p}`).join("\n")}`,
        }
      }
    }

    return { ok: true, organization: org, project }
  } catch (err) {
    return {
      ok: false,
      error: `error discovering ADO context: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
