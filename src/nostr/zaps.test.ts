import type { Event } from 'nostr-tools/core'
import * as nip44 from 'nostr-tools/nip44'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { generateAesKey } from '../crypto/aes'
import { BWF_VERSION_TAG, KIND_ZAP_RECEIPT } from '../types'
import { buildZapRequestTemplate, padRewardAddress, parseZapReceipt, unpadRewardAddress } from './zaps'

const bettorSk = generateSecretKey()
const providerSk = generateSecretKey()
const providerPk = getPublicKey(providerSk)
const adminPk = getPublicKey(generateSecretKey())
const poolId = 'ab'.repeat(32)

async function makeReceipt(opts: {
  aesKey: Uint8Array
  poolIdInRequest?: string
  amountSats?: number
  tamperRequestSig?: boolean
}): Promise<Event> {
  const request = finalizeEvent(
    await buildZapRequestTemplate({
      poolId: opts.poolIdInRequest ?? poolId,
      adminPubkey: adminPk,
      bettorPubkey: getPublicKey(bettorSk),
      amountSats: opts.amountSats ?? 1000,
      relays: ['wss://relay.damus.io'],
      payload: { optionId: 'a', rewardAddress: 'plain:winner@wallet.com' },
      aesKey: opts.aesKey,
    }),
    bettorSk,
  )
  if (opts.tamperRequestSig) request.sig = request.sig.replace(/^./, request.sig.startsWith('0') ? '1' : '0')
  // No bolt11 tag in this synthetic receipt → the parser falls back to the amount tag.
  return finalizeEvent(
    {
      kind: KIND_ZAP_RECEIPT,
      created_at: request.created_at + 1,
      tags: [
        ['p', adminPk],
        ['e', poolId],
        ['description', JSON.stringify(request)],
      ],
      content: '',
    },
    providerSk,
  )
}

describe('zap content size', () => {
  it('is a constant 220 chars regardless of address length, under the common 255 limit', async () => {
    const aesKey = generateAesKey()
    const convKey = nip44.getConversationKey(bettorSk, adminPk)
    const lengths = new Set<number>()
    for (const addr of ['a@b.io', 'dana@walletofsatoshi.com', 'x'.repeat(56) + '@ln.com']) {
      const nip44Ct = nip44.encrypt(padRewardAddress(addr), convKey)
      const template = await buildZapRequestTemplate({
        poolId,
        adminPubkey: adminPk,
        bettorPubkey: getPublicKey(bettorSk),
        amountSats: 100_000,
        relays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'],
        payload: { optionId: 'z', rewardAddress: `nip44:${nip44Ct}` },
        aesKey,
      })
      lengths.add(template.content.length)
    }
    expect(lengths).toEqual(new Set([220]))
  })
})

describe('reward address padding', () => {
  it('round-trips and always pads to the same length', () => {
    for (const addr of ['a@b.io', 'dana@walletofsatoshi.com', 'x'.repeat(56) + '@ln.com']) {
      const padded = padRewardAddress(addr)
      expect(padded.length).toBe(63)
      expect(unpadRewardAddress(padded)).toBe(addr)
    }
  })

  it('rejects addresses longer than the cap', () => {
    expect(() => padRewardAddress('x'.repeat(60) + '@ln.io')).toThrow(/63/)
  })
})

describe('zap receipts as bets', () => {
  it('reconstructs a valid bet', async () => {
    const aesKey = generateAesKey()
    const receipt = await makeReceipt({ aesKey, amountSats: 2100 })
    const bet = await parseZapReceipt(receipt, { poolId, adminPubkey: adminPk, aesKey, providerPubkey: providerPk })
    expect(bet).not.toBeNull()
    expect(bet!.optionId).toBe('a')
    expect(bet!.amountSats).toBe(2100)
    expect(bet!.bettorPubkey).toBe(getPublicKey(bettorSk))
    expect(bet!.rewardAddress).toBe('plain:winner@wallet.com')
  })

  it('rejects receipts from an unexpected provider', async () => {
    const aesKey = generateAesKey()
    const receipt = await makeReceipt({ aesKey })
    const bet = await parseZapReceipt(receipt, {
      poolId,
      adminPubkey: adminPk,
      aesKey,
      providerPubkey: getPublicKey(generateSecretKey()),
    })
    expect(bet).toBeNull()
  })

  it('rejects zap requests with a forged signature', async () => {
    const aesKey = generateAesKey()
    const receipt = await makeReceipt({ aesKey, tamperRequestSig: true })
    expect(await parseZapReceipt(receipt, { poolId, adminPubkey: adminPk, aesKey, providerPubkey: providerPk })).toBeNull()
  })

  it('rejects zaps that target a different pool', async () => {
    const aesKey = generateAesKey()
    const receipt = await makeReceipt({ aesKey, poolIdInRequest: 'cd'.repeat(32) })
    expect(await parseZapReceipt(receipt, { poolId, adminPubkey: adminPk, aesKey, providerPubkey: providerPk })).toBeNull()
  })

  it('rejects zaps whose content is not encrypted with the pool key', async () => {
    const receipt = await makeReceipt({ aesKey: generateAesKey() })
    expect(
      await parseZapReceipt(receipt, { poolId, adminPubkey: adminPk, aesKey: generateAesKey(), providerPubkey: providerPk }),
    ).toBeNull()
  })

  it("rejects a payload transplanted from another bettor's zap (AAD binding)", async () => {
    const aesKey = generateAesKey()
    const original = await makeReceipt({ aesKey })
    const originalRequest = JSON.parse(original.tags.find((t) => t[0] === 'description')![1]!) as Event
    // An attacker copies the ciphertext into their own zap request without knowing the key.
    const attackerSk = generateSecretKey()
    const stolen = finalizeEvent(
      {
        kind: originalRequest.kind,
        created_at: originalRequest.created_at + 1,
        tags: originalRequest.tags,
        content: originalRequest.content,
      },
      attackerSk,
    )
    const receipt = finalizeEvent(
      {
        kind: KIND_ZAP_RECEIPT,
        created_at: stolen.created_at + 1,
        tags: [['p', adminPk], ['e', poolId], ['description', JSON.stringify(stolen)]],
        content: '',
      },
      providerSk,
    )
    expect(await parseZapReceipt(receipt, { poolId, adminPubkey: adminPk, aesKey, providerPubkey: providerPk })).toBeNull()
    // Sanity: the original, non-transplanted receipt still parses.
    expect(
      await parseZapReceipt(original, { poolId, adminPubkey: adminPk, aesKey, providerPubkey: providerPk }),
    ).not.toBeNull()
  })

  it('a self-signed forged receipt (no real payment) is rejected outright', async () => {
    // An attacker who knows the pool's AES key (anyone with the share link
    // does) can build a perfectly-valid-looking zap request and wrap it in
    // their own self-signed "receipt" — the one thing they can't fake is the
    // admin's actual LNURL provider signature.
    const aesKey = generateAesKey()
    const forgedRequest = finalizeEvent(
      await buildZapRequestTemplate({
        poolId,
        adminPubkey: adminPk,
        bettorPubkey: getPublicKey(bettorSk),
        amountSats: 1_000_000, // claim a huge bet
        relays: ['wss://relay.damus.io'],
        payload: { optionId: 'a', rewardAddress: 'plain:attacker@wallet.com' },
        aesKey,
      }),
      bettorSk,
    )
    const attackerSk = generateSecretKey() // NOT the real LNURL provider
    const forgedReceipt = finalizeEvent(
      {
        kind: KIND_ZAP_RECEIPT,
        created_at: forgedRequest.created_at + 1,
        tags: [['p', adminPk], ['e', poolId], ['description', JSON.stringify(forgedRequest)]],
        content: '',
      },
      attackerSk,
    )
    expect(
      await parseZapReceipt(forgedReceipt, { poolId, adminPubkey: adminPk, aesKey, providerPubkey: providerPk }),
    ).toBeNull()
  })
})

describe('bwf-version tag', () => {
  it('is attached to the zap request', async () => {
    const template = await buildZapRequestTemplate({
      poolId,
      adminPubkey: adminPk,
      bettorPubkey: getPublicKey(bettorSk),
      amountSats: 1000,
      relays: ['wss://relay.damus.io'],
      payload: { optionId: 'a', rewardAddress: 'plain:winner@wallet.com' },
      aesKey: generateAesKey(),
    })
    expect(template.tags).toContainEqual(BWF_VERSION_TAG)
  })
})
