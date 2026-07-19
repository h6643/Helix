/**
 * API Key encryption.
 *
 * Primary mechanism: Electron `safeStorage` (OS keychain — DPAPI on Windows,
 * Keychain on macOS, libsecret on Linux), invoked over IPC from the main
 * process. The OS key is bound to the user account, so a DB dump alone can't
 * recover the key. Ciphertext from safeStorage is stored with an `ss:`
 * marker so we can tell it apart from the legacy Web Crypto format below.
 *
 * Legacy / fallback: the previous scheme derived an AES-GCM key from a fixed
 * salt + `navigator.userAgent.length` (effectively public). We keep it ONLY to
 * (a) decrypt values written by older builds during a one-time migration, and
 * (b) cover pure-browser runs where safeStorage is unavailable. As soon as a
 * value is re-saved it is re-encrypted with safeStorage, so legacy blobs age
 * out automatically.
 */

const SAFE_MARKER = 'ss:'

function electronSecure(): null | {
  encrypt: (p: string) => Promise<string | null>
  decrypt: (b: string) => Promise<string | null>
} {
  const e = typeof window !== 'undefined' ? (window as any).electron : undefined
  if (e?.secure) return e.secure
  return null
}

// ── Legacy Web Crypto (migration / browser fallback) ───────────────────────
const SALT = 'helix-api-key-encryption-salt-v1'
const ALGO = 'AES-GCM'
const KEY_LENGTH = 256

let cachedLegacyKey: CryptoKey | null = null

async function getLegacyKey(): Promise<CryptoKey> {
  if (cachedLegacyKey) return cachedLegacyKey
  const encoder = new TextEncoder()
  const salt = encoder.encode(SALT)
  const password = encoder.encode(
    `helix-${typeof navigator !== 'undefined' ? navigator.userAgent.length : 42}`,
  )
  const keyMaterial = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveKey'])
  cachedLegacyKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: ALGO, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  )
  return cachedLegacyKey
}

async function legacyEncrypt(plaintext: string): Promise<string> {
  const key = await getLegacyKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt({ name: ALGO, iv }, key, encoded)
  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return btoa(String.fromCharCode(...combined))
}

async function legacyDecrypt(encrypted: string): Promise<string> {
  const key = await getLegacyKey()
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0))
  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)
  const decrypted = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ciphertext)
  return new TextDecoder().decode(decrypted)
}

function isBase64(str: string): boolean {
  try {
    return btoa(atob(str)) === str
  } catch {
    return false
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function encryptApiKey(plaintext: string): Promise<string> {
  if (!plaintext) return ''
  const secure = electronSecure()
  if (secure) {
    try {
      const b64 = await secure.encrypt(plaintext)
      if (b64) return SAFE_MARKER + b64
    } catch {
      /* fall through to legacy */
    }
  }
  // Browser or safeStorage unavailable — legacy fallback (weak, but better
  // than plaintext). Only reached when not running inside Electron.
  try {
    return await legacyEncrypt(plaintext)
  } catch {
    return plaintext
  }
}

export async function decryptApiKey(stored: string): Promise<string> {
  if (!stored) return ''

  // New format: safeStorage blob.
  if (stored.startsWith(SAFE_MARKER)) {
    const secure = electronSecure()
    const b64 = stored.slice(SAFE_MARKER.length)
    if (secure) {
      try {
        const plain = await secure.decrypt(b64)
        if (plain !== null) return plain
      } catch {
        /* fall through — may be cross-account/cross-machine blob */
      }
    }
    // Can't decrypt (unavailable, or moved across OS account). Surface empty
    // so the caller treats it as "key needs re-entry" rather than leaking the
    // ciphertext as if it were the plaintext.
    return ''
  }

  // Legacy format: base64(iv+ciphertext) from the old Web Crypto scheme.
  if (!isBase64(stored)) return stored // genuinely plain — return as-is
  try {
    return await legacyDecrypt(stored)
  } catch {
    return ''
  }
}
