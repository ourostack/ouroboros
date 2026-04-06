import type { ToolDefinition, ToolContext } from "./tools-base"
import {
  updateUserProfileFields,
  getUserProfileField,
  deleteUserProfile,
} from "./user-profile"
import { getCredentialStore } from "./credential-access"
import { emitNervesEvent } from "../nerves/runtime"

function requireFamilyContext(ctx?: ToolContext): { friendId: string } | string {
  if (!ctx?.context?.friend?.id) {
    return "no friend context — cannot access user profile."
  }
  if (ctx.context.friend.trustLevel !== "family") {
    return "user profile access requires family trust level."
  }
  return { friendId: ctx.context.friend.id }
}

export const userProfileToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "user_profile_store",
        description:
          "Store or update user profile fields (legal name, DOB, passport, etc.) in the agent's vault. Fields are merged with any existing profile. Requires family trust level.",
        parameters: {
          type: "object",
          properties: {
            fields: {
              type: "string",
              description:
                'JSON object with profile fields to store/update. Keys: legalName, dateOfBirth, gender, nationality, passport, driverLicense, email, phone, addresses, loyaltyPrograms, preferences, emergencyContact.',
            },
          },
          required: ["fields"],
        },
      },
    },
    handler: async (args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_user_profile_store",
        message: "user_profile_store invoked",
        meta: { tool: "user_profile_store" },
      })

      const guard = requireFamilyContext(ctx)
      if (typeof guard === "string") return guard

      let fields: Record<string, unknown>
      try {
        fields = JSON.parse(args.fields)
      } catch {
        return "invalid JSON in fields parameter."
      }

      try {
        const store = getCredentialStore()
        await updateUserProfileFields(guard.friendId, fields as any, store)
        return `profile fields stored for ${guard.friendId}.`
      } catch (err) {
        /* v8 ignore next -- defensive: updateUserProfileFields errors are always Error instances @preserve */
        return `failed to store profile: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    summaryKeys: ["fields"],
  },

  {
    tool: {
      type: "function",
      function: {
        name: "user_profile_get",
        description:
          "Retrieve a specific field from a user's profile. Only returns the requested field, never the full profile. Requires family trust level.",
        parameters: {
          type: "object",
          properties: {
            field: {
              type: "string",
              description:
                "The profile field to retrieve: legalName, dateOfBirth, gender, nationality, passport, driverLicense, email, phone, addresses, loyaltyPrograms, preferences, emergencyContact.",
            },
          },
          required: ["field"],
        },
      },
    },
    handler: async (args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_user_profile_get",
        message: "user_profile_get invoked",
        meta: { tool: "user_profile_get", field: args.field },
      })

      const guard = requireFamilyContext(ctx)
      if (typeof guard === "string") return guard

      try {
        const store = getCredentialStore()
        const value = await getUserProfileField(guard.friendId, args.field as any, store)
        if (value === undefined) {
          return `field "${args.field}" is not set on the profile.`
        }
        /* v8 ignore next -- platform-dependent v8 branch counting on ternary @preserve */
        return typeof value === "string" ? value : JSON.stringify(value, null, 2)
      } catch (err) {
        /* v8 ignore next -- defensive: getUserProfileField errors are always Error instances @preserve */
        return `failed to get profile field: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    summaryKeys: ["field"],
  },

  {
    tool: {
      type: "function",
      function: {
        name: "user_profile_delete",
        description:
          "Delete a user's entire profile from the vault. This is irreversible. Requires family trust level.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    handler: async (_args, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.tool_user_profile_delete",
        message: "user_profile_delete invoked",
        meta: { tool: "user_profile_delete" },
      })

      const guard = requireFamilyContext(ctx)
      if (typeof guard === "string") return guard

      try {
        const store = getCredentialStore()
        const deleted = await deleteUserProfile(guard.friendId, store)
        return deleted
          ? `profile deleted for ${guard.friendId}.`
          : `no profile found for ${guard.friendId}.`
      } catch (err) {
        /* v8 ignore next -- defensive: deleteUserProfile errors are always Error instances @preserve */
        return `failed to delete profile: ${err instanceof Error ? err.message : String(err)}`
      }
    },
    summaryKeys: [],
  },
]
