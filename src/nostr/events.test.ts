import type { Event } from 'nostr-tools/core'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { generateAesKey } from '../crypto/aes'
import type { PoolContent } from '../types'
import {
  buildAdminActionTemplate,
  buildCommentTemplate,
  buildPoolTemplate,
  buildShareHash,
  foldAdminActions,
  parseComment,
  parsePoolEvent,
  parseShareHash,
} from './events'

const adminSk = generateSecretKey()
const adminPk = getPublicKey(adminSk)
const strangerSk = generateSecretKey()

const content: PoolContent = {
  v: 1,
  title: 'Champions League Final',
  description: 'Winner takes all',
  options: [
    { id: 'a', title: 'Real Madrid' },
    { id: 'b', title: 'Arsenal', description: 'the underdog' },
  ],
  adminFeePct: 2,
  maxBets: 20,
  maxBetSats: 100_000,
}

describe('pool events', () => {
  it('round-trips a pool through encrypt/sign/parse', async () => {
    const key = generateAesKey()
    const event = finalizeEvent(await buildPoolTemplate(content, key), adminSk)
    expect(event.content).not.toContain('Real Madrid')
    const pool = await parsePoolEvent(event, key, ['wss://relay.damus.io'])
    expect(pool.content).toEqual(content)
    expect(pool.adminPubkey).toBe(adminPk)
    expect(pool.id).toBe(event.id)
  })

  it('rejects decryption with a wrong key', async () => {
    const event = finalizeEvent(await buildPoolTemplate(content, generateAesKey()), adminSk)
    await expect(parsePoolEvent(event, generateAesKey(), [])).rejects.toThrow(/decrypt/)
  })

  it('rejects invalid pool content at build time', async () => {
    const bad = { ...content, options: [content.options[0]!] }
    await expect(buildPoolTemplate(bad as PoolContent, generateAesKey())).rejects.toThrow(/2 options/)
  })
})

describe('share links', () => {
  it('round-trips through the URL hash', () => {
    const key = generateAesKey()
    const poolId = 'ab'.repeat(32)
    const hash = buildShareHash({
      poolId,
      adminPubkey: adminPk,
      relays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://extra.example'],
      aesKey: key,
    })
    const ref = parseShareHash(hash)
    expect(ref).not.toBeNull()
    expect(ref!.poolId).toBe(poolId)
    expect(ref!.adminPubkey).toBe(adminPk)
    expect(ref!.relays).toHaveLength(3) // capped hints
    expect(ref!.aesKey).toEqual(key)
  })

  it('rejects malformed hashes', () => {
    expect(parseShareHash('#/p/garbage/key')).toBeNull()
    expect(parseShareHash('#/create')).toBeNull()
    expect(parseShareHash('')).toBeNull()
  })

  it('rejects non-canonical key encodings (flipped base64 padding bits)', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    for (let i = 0; i < 10; i++) {
      const hash = buildShareHash({
        poolId: 'ab'.repeat(32),
        adminPubkey: adminPk,
        relays: [],
        aesKey: generateAesKey(),
      })
      // Flip the lowest bit of the final character: decodes to the same 32
      // bytes (it's a padding bit), but the encoding is no longer canonical.
      const last = hash[hash.length - 1]!
      const twin = alphabet[alphabet.indexOf(last) ^ 1]!
      expect(parseShareHash(hash)).not.toBeNull()
      expect(parseShareHash(hash.slice(0, -1) + twin)).toBeNull()
    }
  })
})

describe('admin actions', () => {
  async function makePool(key: Uint8Array) {
    const event = finalizeEvent(await buildPoolTemplate(content, key), adminSk)
    return parsePoolEvent(event, key, [])
  }

  async function action(key: Uint8Array, poolId: string, a: Parameters<typeof buildAdminActionTemplate>[1], sk = adminSk, ts?: number): Promise<Event> {
    const template = await buildAdminActionTemplate(poolId, a, key)
    if (ts !== undefined) template.created_at = ts
    return finalizeEvent(template, sk)
  }

  it('folds close, winner and paid/unpaid toggles', async () => {
    const key = generateAesKey()
    const pool = await makePool(key)
    const events = [
      await action(key, pool.id, { action: 'close' }, adminSk, 100),
      await action(key, pool.id, { action: 'winner', optionId: 'b' }, adminSk, 200),
      await action(key, pool.id, { action: 'paid', receiptId: 'r1' }, adminSk, 300),
      await action(key, pool.id, { action: 'paid', receiptId: 'r2' }, adminSk, 310),
      await action(key, pool.id, { action: 'unpaid', receiptId: 'r1' }, adminSk, 320),
    ]
    const status = await foldAdminActions(events, pool, key)
    expect(status.closed).toBe(true)
    expect(status.winnerOptionId).toBe('b')
    expect(status.paidReceiptIds).toEqual(new Set(['r2']))
  })

  it('ignores actions signed by non-admins', async () => {
    const key = generateAesKey()
    const pool = await makePool(key)
    const forged = await action(key, pool.id, { action: 'winner', optionId: 'a' }, strangerSk)
    const status = await foldAdminActions([forged], pool, key)
    expect(status.winnerOptionId).toBeNull()
    expect(status.closed).toBe(false)
  })

  it('cancel closes betting and clears any earlier winner', async () => {
    const key = generateAesKey()
    const pool = await makePool(key)
    const events = [
      await action(key, pool.id, { action: 'winner', optionId: 'a' }, adminSk, 100),
      await action(key, pool.id, { action: 'cancel' }, adminSk, 200),
    ]
    const status = await foldAdminActions(events, pool, key)
    expect(status.cancelled).toBe(true)
    expect(status.closed).toBe(true)
    expect(status.winnerOptionId).toBeNull()
  })

  it('a winner declared after a cancel overrides it (latest decision wins)', async () => {
    const key = generateAesKey()
    const pool = await makePool(key)
    const events = [
      await action(key, pool.id, { action: 'cancel' }, adminSk, 100),
      await action(key, pool.id, { action: 'winner', optionId: 'b' }, adminSk, 200),
    ]
    const status = await foldAdminActions(events, pool, key)
    expect(status.cancelled).toBe(false)
    expect(status.winnerOptionId).toBe('b')
  })

  it('declaring a winner also closes betting', async () => {
    const key = generateAesKey()
    const pool = await makePool(key)
    const status = await foldAdminActions(
      [await action(key, pool.id, { action: 'winner', optionId: 'a' })],
      pool,
      key,
    )
    expect(status.closed).toBe(true)
  })
})

describe('comments', () => {
  it('round-trips a comment and ignores undecryptable ones', async () => {
    const key = generateAesKey()
    const event = finalizeEvent(await buildCommentTemplate('p'.repeat(64), 'good luck! 🍀', key), adminSk)
    const comment = await parseComment(event, key)
    expect(comment?.text).toBe('good luck! 🍀')
    expect(await parseComment(event, generateAesKey())).toBeNull()
  })
})
