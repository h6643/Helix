/**
 * API Key encryption using Web Crypto API (AES-GCM).
 * Keys are encrypted before persisting to IndexedDB.
 */

const SALT = 'helix-api-key-encryption-salt-v1'
const ALGO = 'AES-GCM'
const KEY_LENGTH = 256

let cachedKey: CryptoKey | null = null

async function getEncryptionKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey

  // Derive a key from a fixed salt using PBKDF2
  const encoder = new TextEncoder()
  const salt = encoder.encode(SALT)

  // Use a device-specific component as password (not truly secret, but prevents plain-text extraction)
  const password = encoder.encode(
    `helix-${typeof navigator !== 'undefined' ? navigator.userAgent.length : 42}`
  )

  const keyMaterial = await crypto.subtle.importKey(
    'raw', password, 'PBKDF2', false, ['deriveKey']
  )

  cachedKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: ALGO, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  )

  return cachedKey
}

export async function encryptApiKey(plaintext: string): Promise<string> {
  if (!plaintext) return ''
  try {
    const key = await getEncryptionKey()
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encoded = new TextEncoder().encode(plaintext)
    const ciphertext = await crypto.subtle.encrypt({ name: ALGO, iv }, key, encoded)
    // Store as base64(iv.ciphertext)
    const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length)
    combined.set(iv, 0)
    combined.set(new Uint8Array(ciphertext), iv.length)
    return btoa(String.fromCharCode(...combined))
  } catch {
    return plaintext // Fallback: return plaintext if crypto unavailable
  }
}

export async function decryptApiKey(encrypted: string): Promise<string> {
  if (!encrypted) return ''
  // If not base64-encoded (legacy plaintext), return as-is
  if (!isBase64(encrypted)) return encrypted
  try {
    const key = await getEncryptionKey()
    const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0))
    const iv = combined.slice(0, 12)
    const ciphertext = combined.slice(12)
    const decrypted = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ciphertext)
    return new TextDecoder().decode(decrypted)
  } catch {
    return encrypted // Fallback: return as-is if decryption fails
  }
}

function isBase64(str: string): boolean {
  try {
    return btoa(atob(str)) === str
  } catch {
    return false
  }
}
