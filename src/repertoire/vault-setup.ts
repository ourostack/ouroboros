/**
 * Vault setup module — Bitwarden/Vaultwarden account creation.
 *
 * Implements the Bitwarden registration protocol using Node.js crypto:
 * - PBKDF2-SHA256 for master key derivation
 * - HKDF-SHA256 for key stretching
 * - AES-256-CBC for symmetric key protection
 * - RSA-2048 keypair for asymmetric encryption
 *
 * All crypto follows the Bitwarden security whitepaper:
 * https://bitwarden.com/help/bitwarden-security-white-paper/
 */

import * as crypto from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VaultSetupResult {
  success: boolean
  email: string
  serverUrl: string
  error?: string
}

// ---------------------------------------------------------------------------
// Crypto primitives
// ---------------------------------------------------------------------------

/**
 * Derive the master key from password and email using PBKDF2-SHA256.
 * Email is lowercased and used as the salt per Bitwarden spec.
 */
export function deriveMasterKey(
  password: string,
  email: string,
  iterations: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(
      password,
      email.toLowerCase(),
      iterations,
      32,
      "sha256",
      (err, key) => {
        /* v8 ignore next -- defensive: pbkdf2 rejects on invalid input @preserve */
        if (err) reject(err)
        else resolve(key)
      },
    )
  })
}

/**
 * Derive the master password hash: PBKDF2-SHA256(masterKey, password, 1 iteration).
 * This hash is sent to the server for authentication — it never sees the master key.
 */
export function deriveMasterPasswordHash(
  masterKey: Buffer,
  password: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(
      masterKey,
      password,
      1,
      32,
      "sha256",
      (err, hash) => {
        /* v8 ignore next -- defensive: pbkdf2 rejects on invalid input @preserve */
        if (err) reject(err)
        else resolve(hash.toString("base64"))
      },
    )
  })
}

/**
 * Stretch the master key using HKDF-Expand-only (RFC 5869 §2.3) to produce a 64-byte key.
 * First 32 bytes = encryption key, last 32 bytes = MAC key.
 *
 * CRITICAL: Bitwarden uses HKDF-Expand ONLY (no Extract step).
 * Node.js crypto.hkdfSync() does Extract+Expand which produces DIFFERENT output.
 * Reference: https://github.com/bitwarden/sdk-internal/blob/main/crates/bitwarden-crypto/src/util.rs
 * Bitwarden calls Hkdf::<Sha256>::from_prk(masterKey).expand(info, output) — Expand only.
 */
export function deriveStretchedMasterKey(masterKey: Buffer): Buffer {
  const encKey = hkdfExpandOnly(masterKey, "enc", 32)
  const macKey = hkdfExpandOnly(masterKey, "mac", 32)
  return Buffer.concat([encKey, macKey])
}

/**
 * HKDF-Expand only (RFC 5869 §2.3) — no Extract step.
 * Matches Bitwarden's Hkdf::from_prk(prk).expand(info).
 */
function hkdfExpandOnly(prk: Buffer, info: string, length: number): Buffer {
  const hashLen = 32 // SHA-256
  const n = Math.ceil(length / hashLen)
  let okm = Buffer.alloc(0)
  let t = Buffer.alloc(0)
  for (let i = 1; i <= n; i++) {
    t = crypto.createHmac("sha256", prk)
      .update(Buffer.concat([t, Buffer.from(info, "utf8"), Buffer.from([i])]))
      .digest()
    okm = Buffer.concat([okm, t])
  }
  return okm.subarray(0, length)
}

/**
 * Encrypt data with AES-256-CBC and HMAC-SHA256 MAC.
 * Returns a Bitwarden "type 2" cipherstring: "2.<iv>|<ct>|<mac>"
 */
function encryptWithStretchedKey(data: Buffer, stretchedKey: Buffer): string {
  const encKey = stretchedKey.subarray(0, 32)
  const macKey = stretchedKey.subarray(32, 64)

  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv("aes-256-cbc", encKey, iv)
  const ct = Buffer.concat([cipher.update(data), cipher.final()])

  // MAC covers iv + ct
  const mac = crypto.createHmac("sha256", macKey)
    .update(iv)
    .update(ct)
    .digest()

  return `2.${iv.toString("base64")}|${ct.toString("base64")}|${mac.toString("base64")}`
}

/**
 * Generate a 64-byte symmetric key, encrypt it with the stretched master key.
 * Returns the "protected symmetric key" cipherstring.
 */
export function makeProtectedSymmetricKey(stretchedMasterKey: Buffer): string {
  const symKey = crypto.randomBytes(64)
  return encryptWithStretchedKey(symKey, stretchedMasterKey)
}

/**
 * Generate an RSA-2048 keypair.
 * Returns { publicKey: base64-DER, privateKeyDer: Buffer }.
 */
function generateRsaKeypair(): { publicKeyB64: string; privateKeyDer: Buffer } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  })

  return {
    publicKeyB64: (publicKey as Buffer).toString("base64"),
    privateKeyDer: privateKey as Buffer,
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const KDF_PBKDF2 = 0
const KDF_ITERATIONS = 600000
const REGISTER_ACCOUNT_PATH = "/identity/accounts/register"

/**
 * Create a Bitwarden account on the configured Vaultwarden server.
 * Uses the Bitwarden registration API with standard KDF implementation.
 */
export async function createVaultAccount(
  agentName: string,
  serverUrl: string,
  email: string,
  masterPassword: string,
): Promise<VaultSetupResult> {
  emitNervesEvent({
    event: "repertoire.vault_setup_start",
    component: "repertoire",
    message: `creating vault account for ${agentName}`,
    meta: { agentName, serverUrl, email },
  })

  try {
    // Step 1: Derive keys
    const masterKey = await deriveMasterKey(masterPassword, email, KDF_ITERATIONS)
    const masterPasswordHash = await deriveMasterPasswordHash(masterKey, masterPassword)
    const stretchedKey = deriveStretchedMasterKey(masterKey)

    // Step 2: Generate symmetric key (64 bytes = 32 enc + 32 mac), encrypt with stretched key
    const symKey = crypto.randomBytes(64)
    const protectedSymKey = encryptWithStretchedKey(symKey, stretchedKey)

    // Step 3: Generate RSA keypair, encrypt private key with the symmetric key
    const { publicKeyB64, privateKeyDer } = generateRsaKeypair()
    const encryptedPrivateKey = encryptWithStretchedKey(privateKeyDer, symKey)

    // Step 4: POST registration
    const registrationUrl = `${serverUrl}${REGISTER_ACCOUNT_PATH}`
    const res = await fetch(registrationUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: agentName,
        email,
        masterPasswordHash,
        masterPasswordHint: null,
        key: protectedSymKey,
        kdf: KDF_PBKDF2,
        kdfIterations: KDF_ITERATIONS,
        keys: {
          publicKey: publicKeyB64,
          encryptedPrivateKey,
        },
      }),
    })

    if (!res.ok) {
      let errorDetail: string
      try {
        const body = await res.json()
        errorDetail = body.message ?? `HTTP ${res.status} ${res.statusText}`
      } catch {
        errorDetail = `HTTP ${res.status} ${res.statusText}`
      }
      const endpointAwareError = `${errorDetail} from ${registrationUrl}. Check --server; Ouro expects a Bitwarden/Vaultwarden identity API.`

      emitNervesEvent({
        level: "error",
        event: "repertoire.vault_setup_error",
        component: "repertoire",
        message: `vault registration failed: ${endpointAwareError}`,
        meta: { agentName, serverUrl, email, registrationUrl, reason: endpointAwareError },
      })

      return { success: false, email, serverUrl, error: endpointAwareError }
    }

    emitNervesEvent({
      event: "repertoire.vault_setup_end",
      component: "repertoire",
      message: `vault account created for ${agentName}`,
      meta: { agentName, serverUrl, email },
    })

    return { success: true, email, serverUrl }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const registrationUrl = `${serverUrl}${REGISTER_ACCOUNT_PATH}`
    const endpointAwareError = `cannot reach vault registration endpoint ${registrationUrl}: ${reason}. Check network, DNS/TLS, and --server.`
    emitNervesEvent({
      level: "error",
      event: "repertoire.vault_setup_error",
      component: "repertoire",
      message: `vault setup failed: ${endpointAwareError}`,
      meta: { agentName, serverUrl, email, registrationUrl, reason: endpointAwareError },
    })

    return { success: false, email, serverUrl, error: endpointAwareError }
  }
}
