import { withCode, type ToolDefinition, type ToolContext, type ToolErrorCard } from "./tools-base"
import {
  updateUserProfileFields,
  getUserProfileField,
  deleteUserProfile,
} from "./user-profile"
import { getCredentialStore } from "./credential-access"
import { emitNervesEvent } from "../nerves/runtime"

function requireFamilyContext(ctx?: ToolContext): { friendId: string } | string {
  if (!ctx?.context?.friend?.id) {
    return withCode("no friend context — cannot access user profile.", "no-friend-context")
  }
  if (ctx.context.friend.trustLevel !== "family") {
    return withCode("user profile access requires family trust level.", "family-required")
  }
  return { friendId: ctx.context.friend.id }
}

const NO_FRIEND_ERROR: ToolErrorCard = { code: "no-friend-context", means: "This call came from outside any conversation with a known person, so there is no profile to use.", fix: "Use this only inside a conversation with the person whose profile it is." }
const FAMILY_REQUIRED_ERROR: ToolErrorCard = { code: "family-required", means: "The person in this conversation isn't family, and profiles hold passport-level details.", fix: "Don't retry; tell the person only a family member can see or change these details." }
const GUARDRAIL_ERROR: ToolErrorCard = { code: "guardrail-blocked", means: "The trust guardrail stopped the call before it ran, because only family may touch profile details.", fix: "Don't retry; tell the person only a family member can see or change these details." }

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
        return withCode("invalid JSON in fields parameter.", "profile-fields-invalid")
      }

      try {
        const store = getCredentialStore()
        await updateUserProfileFields(guard.friendId, fields as any, store)
        return `profile fields stored for ${guard.friendId}.`
      } catch (err) {
        /* v8 ignore next -- defensive: updateUserProfileFields errors are always Error instances @preserve */
        return withCode(`failed to store profile: ${err instanceof Error ? err.message : String(err)}`, "profile-store-failed")
      }
    },
    summaryKeys: ["fields"],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "stores user profile vault fields" },
    ax: { id: "tool:user_profile_store", group: "turn-vault", when: "Pick this when the person gives details a booking needs, such as their legal name or passport, to keep them for next time.", effect: "write", idempotent: true, errors: [
      NO_FRIEND_ERROR, FAMILY_REQUIRED_ERROR, GUARDRAIL_ERROR,
      { code: "profile-fields-invalid", means: "fields isn't valid JSON.", fix: "Send fields as a JSON object string, such as {\"email\":\"a@b.com\"}." },
      { code: "profile-store-failed", means: "The vault refused the save; the text gives the reason.", fix: "Check the vault is unlocked with vault_setup's commands, then save again." },
    ] },
  },

  {
    tool: {
      type: "function",
      function: {
        name: "user_profile_get",
        description:
          "Retrieve a specific field from a user's profile. Returns only the requested field, not the full profile. Requires family trust level.",
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
          return withCode(`field "${args.field}" is not set on the profile.`, "profile-field-not-set")
        }
        /* v8 ignore next -- platform-dependent v8 branch counting on ternary @preserve */
        return typeof value === "string" ? value : JSON.stringify(value, null, 2)
      } catch (err) {
        /* v8 ignore next -- defensive: getUserProfileField errors are always Error instances @preserve */
        return withCode(`failed to get profile field: ${err instanceof Error ? err.message : String(err)}`, "profile-read-failed")
      }
    },
    summaryKeys: ["field"],
    riskProfile: { mutates: "none", risk: "low", reason: "reads one profile field from the vault" },
    ax: { id: "tool:user_profile_get", group: "turn-vault", when: "Pick this to fill one form field from the person's saved details, such as their date of birth, without exposing the rest.", effect: "read", idempotent: true, errors: [
      NO_FRIEND_ERROR, FAMILY_REQUIRED_ERROR, GUARDRAIL_ERROR,
      { code: "profile-field-not-set", means: "The profile exists but has nothing saved in that field.", fix: "Ask the person for it, then save it with user_profile_store." },
      { code: "profile-read-failed", means: "The vault couldn't be read; the text gives the reason.", fix: "Check the vault is unlocked with vault_setup's commands, then read again." },
    ] },
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
          : withCode(`no profile found for ${guard.friendId}.`, "profile-not-found")
      } catch (err) {
        /* v8 ignore next -- defensive: deleteUserProfile errors are always Error instances @preserve */
        return withCode(`failed to delete profile: ${err instanceof Error ? err.message : String(err)}`, "profile-delete-failed")
      }
    },
    summaryKeys: [],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "deletes user profile vault item" },
    ax: { id: "tool:user_profile_delete", group: "turn-vault", when: "Pick this only when the person asks to erase everything saved about them; every field goes and it can't be undone.", effect: "write", destructive: true, idempotent: true, errors: [
      NO_FRIEND_ERROR, FAMILY_REQUIRED_ERROR, GUARDRAIL_ERROR,
      { code: "profile-not-found", means: "Nothing is saved for this person, so there was nothing to delete.", fix: "Tell the person no details were saved; there's nothing more to do." },
      { code: "profile-delete-failed", means: "The vault refused the delete; the text gives the reason.", fix: "Check the vault is unlocked, then read a field with user_profile_get to see whether the profile is still there." },
    ] },
  },
]
