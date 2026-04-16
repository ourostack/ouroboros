/**
 * User profile model and vault storage.
 *
 * Profiles are stored as secure notes in the agent's Vaultwarden vault,
 * keyed by friend ID: `user-profile/{friendId}`.
 *
 * The storage layer uses the existing CredentialStore interface — the profile
 * JSON is stored in the `password` field of a login item (the vault's most
 * reliable field for arbitrary data). Field-level access ensures the full
 * profile is never dumped to model context unnecessarily.
 */

import type { CredentialStore } from "./credential-access"
import { emitNervesEvent } from "../nerves/runtime"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserProfileName {
  first: string
  middle?: string
  last: string
}

export interface UserProfilePassport {
  number: string
  country: string
  expiry: string
}

export interface UserProfileDriverLicense {
  number: string
  state: string
  expiry: string
}

export interface UserProfileAddress {
  label: string
  street: string
  city: string
  state?: string
  postal: string
  country: string
}

export interface UserProfileLoyaltyProgram {
  program: string
  number: string
}

export interface UserProfileEmergencyContact {
  name: string
  phone: string
  relationship: string
}

export interface UserProfile {
  legalName: UserProfileName
  dateOfBirth?: string
  gender?: string
  nationality?: string
  passport?: UserProfilePassport
  driverLicense?: UserProfileDriverLicense
  email: string
  phone: string
  addresses?: UserProfileAddress[]
  loyaltyPrograms?: UserProfileLoyaltyProgram[]
  preferences: Record<string, string>
  emergencyContact?: UserProfileEmergencyContact
}

// ---------------------------------------------------------------------------
// Storage key
// ---------------------------------------------------------------------------

function profileKey(friendId: string): string {
  return `user-profile/${friendId}`
}

function isMissingUserProfileError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /no credential found/i.test(message) || /field "password" not found/i.test(message)
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/**
 * Store a complete user profile in the vault.
 * Overwrites any existing profile for the given friend ID.
 */
export async function storeUserProfile(
  friendId: string,
  profile: UserProfile,
  store: CredentialStore,
): Promise<void> {
  emitNervesEvent({
    event: "repertoire.user_profile_store",
    component: "repertoire",
    message: `storing user profile for ${friendId}`,
    meta: { friendId },
  })

  const key = profileKey(friendId)
  /* v8 ignore start -- platform-dependent v8 branch counting on await @preserve */
  await store.store(key, {
    password: JSON.stringify(profile),
    notes: "user-profile",
  })
  /* v8 ignore stop */
}

/**
 * Retrieve the full user profile for a friend.
 * Returns null if no profile exists. Throws if the stored data is malformed
 * or the vault cannot be read.
 */
export async function getUserProfile(
  friendId: string,
  store: CredentialStore,
): Promise<UserProfile | null> {
  emitNervesEvent({
    event: "repertoire.user_profile_get",
    component: "repertoire",
    message: `getting user profile for ${friendId}`,
    meta: { friendId },
  })

  try {
    const raw = await store.getRawSecret(profileKey(friendId), "password")
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`stored user profile for ${friendId} is malformed`)
    }
    return parsed as UserProfile
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`stored user profile for ${friendId} is malformed`)
    }
    if (isMissingUserProfileError(err)) {
      return null
    }
    throw err
  }
}

/**
 * Retrieve a specific field from a user profile.
 * Returns undefined if the profile doesn't exist or the field is not set.
 */
export async function getUserProfileField(
  friendId: string,
  field: keyof UserProfile,
  store: CredentialStore,
): Promise<unknown> {
  const profile = await getUserProfile(friendId, store)
  if (!profile) return undefined
  return profile[field]
}

/**
 * Delete a user profile from the vault.
 * Returns true if the profile was deleted, false if it didn't exist.
 */
export async function deleteUserProfile(
  friendId: string,
  store: CredentialStore,
): Promise<boolean> {
  emitNervesEvent({
    event: "repertoire.user_profile_delete",
    component: "repertoire",
    message: `deleting user profile for ${friendId}`,
    meta: { friendId },
  })

  return store.delete(profileKey(friendId))
}

/**
 * Update specific fields on a user profile, merging with existing data.
 * Creates the profile if it doesn't exist.
 * Preferences are merged (not replaced) at the key level.
 */
export async function updateUserProfileFields(
  friendId: string,
  fields: Partial<UserProfile>,
  store: CredentialStore,
): Promise<void> {
  emitNervesEvent({
    event: "repertoire.user_profile_update",
    component: "repertoire",
    message: `updating user profile fields for ${friendId}`,
    meta: { friendId, fieldCount: Object.keys(fields).length },
  })

  const existing = await getUserProfile(friendId, store)

  let merged: UserProfile
  if (existing) {
    // Merge preferences at key level
    const mergedPreferences = {
      ...existing.preferences,
      ...(fields.preferences ?? {}),
    }
    merged = { ...existing, ...fields, preferences: mergedPreferences }
  } else {
    merged = fields as UserProfile
  }

  await storeUserProfile(friendId, merged, store)
}
