/**
 * AES-256-GCM encryption for all pool-related event contents.
 * The 32-byte key is generated once per pool and travels only in the URL hash.
 */

const IV_BYTES = 12

export function generateAesKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replaceAll('-', '+').replaceAll('_', '/')
  return base64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
}

async function importKey(key: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  if (key.length !== 32) throw new Error('AES key must be 32 bytes')
  return crypto.subtle.importKey('raw', key as BufferSource, { name: 'AES-GCM' }, false, [usage])
}

/**
 * Returns iv || ciphertext+tag. The optional AAD is authenticated but not
 * encrypted: decryption fails unless the exact same AAD is supplied, which
 * binds a ciphertext to its context (e.g. a bet payload to its bettor).
 */
export async function aesEncryptBytes(key: Uint8Array, data: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const cryptoKey = await importKey(key, 'encrypt')
  const params: AesGcmParams = { name: 'AES-GCM', iv }
  if (aad) params.additionalData = aad as BufferSource
  const ct = await crypto.subtle.encrypt(params, cryptoKey, data as BufferSource)
  const out = new Uint8Array(IV_BYTES + ct.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ct), IV_BYTES)
  return out
}

/** Inverse of aesEncryptBytes. Throws on wrong key, wrong AAD, or tampered payload. */
export async function aesDecryptBytes(key: Uint8Array, data: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  if (data.length < IV_BYTES + 16) throw new Error('Ciphertext too short')
  const iv = data.slice(0, IV_BYTES)
  const ct = data.slice(IV_BYTES)
  const cryptoKey = await importKey(key, 'decrypt')
  const params: AesGcmParams = { name: 'AES-GCM', iv: iv as BufferSource }
  if (aad) params.additionalData = aad as BufferSource
  const pt = await crypto.subtle.decrypt(params, cryptoKey, ct as BufferSource)
  return new Uint8Array(pt)
}

/** Returns base64(iv || ciphertext+tag). */
export async function aesEncrypt(key: Uint8Array, plaintext: string): Promise<string> {
  return bytesToBase64(await aesEncryptBytes(key, new TextEncoder().encode(plaintext)))
}

/** Inverse of aesEncrypt. Throws on wrong key or tampered payload. */
export async function aesDecrypt(key: Uint8Array, payload: string): Promise<string> {
  return new TextDecoder().decode(await aesDecryptBytes(key, base64ToBytes(payload)))
}
