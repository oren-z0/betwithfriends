import { describe, expect, it } from 'vitest'
import {
  aesDecrypt,
  aesEncrypt,
  base64UrlToBytes,
  bytesToBase64Url,
  generateAesKey,
} from './aes'

describe('aes-256-gcm', () => {
  it('round-trips plaintext', async () => {
    const key = generateAesKey()
    const plaintext = JSON.stringify({ title: 'Who wins the World Cup? ⚽', maxBetSats: 100_000 })
    const ct = await aesEncrypt(key, plaintext)
    expect(ct).not.toContain('World Cup')
    expect(await aesDecrypt(key, ct)).toBe(plaintext)
  })

  it('produces different ciphertexts for the same plaintext (random IV)', async () => {
    const key = generateAesKey()
    expect(await aesEncrypt(key, 'hello')).not.toBe(await aesEncrypt(key, 'hello'))
  })

  it('fails to decrypt with the wrong key', async () => {
    const ct = await aesEncrypt(generateAesKey(), 'secret')
    await expect(aesDecrypt(generateAesKey(), ct)).rejects.toThrow()
  })

  it('fails to decrypt tampered ciphertext', async () => {
    const key = generateAesKey()
    const ct = await aesEncrypt(key, 'secret')
    const tampered = ct.slice(0, -4) + (ct.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    await expect(aesDecrypt(key, tampered)).rejects.toThrow()
  })

  it('round-trips keys through base64url (URL-safe)', () => {
    for (let i = 0; i < 20; i++) {
      const key = generateAesKey()
      const encoded = bytesToBase64Url(key)
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(base64UrlToBytes(encoded)).toEqual(key)
    }
  })
})
