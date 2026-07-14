import { bech32 } from '@scure/base'
import type { Event } from 'nostr-tools/core'
import * as nip44 from 'nostr-tools/nip44'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { generateAesKey } from '../crypto/aes'
import { BWF_VERSION_TAG, KIND_ZAP_RECEIPT } from '../types'
import {
  buildZapRequestTemplate,
  MAX_REWARD_ADDRESS_BYTES,
  padRewardAddress,
  parseZapReceipt,
  TAG_ADDRESS,
  TAG_OPTION,
  unpadRewardAddress,
} from './zaps'

const bettorSk = generateSecretKey()
const bettorPk = getPublicKey(bettorSk)
const providerSk = generateSecretKey()
const providerPk = getPublicKey(providerSk)
const adminSk = generateSecretKey()
const adminPk = getPublicKey(adminSk)
const poolId = 'ab'.repeat(32)

const utf8Len = (s: string) => new TextEncoder().encode(s).length

/** What the app sends as BetPayload.rewardAddress: NIP-44 of the padded address. */
function encryptAddress(address: string): string {
  return nip44.encrypt(padRewardAddress(address), nip44.getConversationKey(bettorSk, adminPk))
}

/** Decodable-but-unpayable bolt11: the msats in the HRP (1 pBTC = 0.1 msat),
 * a zeroed timestamp and a zeroed signature. Same trick as the e2e harness. */
function fakeBolt11(msats: number): string {
  return bech32.encode(`lnbc${msats * 10}p`, new Array(7 + 104).fill(0), 1023)
}

async function makeReceipt(opts: {
  aesKey: Uint8Array
  poolIdInRequest?: string
  amountSats?: number
  tamperRequestSig?: boolean
  /** Override the receipt's bolt11 tag; null omits it entirely. */
  bolt11?: string | null
}): Promise<Event> {
  const request = finalizeEvent(
    await buildZapRequestTemplate({
      poolId: opts.poolIdInRequest ?? poolId,
      adminPubkey: adminPk,
      bettorPubkey: bettorPk,
      amountSats: opts.amountSats ?? 1000,
      relays: ['wss://relay.damus.io'],
      payload: { optionId: 'a', rewardAddress: encryptAddress('winner@wallet.com') },
      aesKey: opts.aesKey,
    }),
    bettorSk,
  )
  if (opts.tamperRequestSig) request.sig = request.sig.replace(/^./, request.sig.startsWith('0') ? '1' : '0')
  return wrapInReceipt(request, { bolt11: opts.bolt11 })
}

/** Wraps a request in a provider receipt whose invoice carries the requested
 * amount (or an override for testing bolt11 handling). */
function wrapInReceipt(request: Event, opts: { bolt11?: string | null } = {}): Event {
  const requestedMsats = Number(request.tags.find((t) => t[0] === 'amount')?.[1] ?? 1_000_000)
  const bolt11 = opts.bolt11 === undefined ? fakeBolt11(requestedMsats) : opts.bolt11
  return finalizeEvent(
    {
      kind: KIND_ZAP_RECEIPT,
      created_at: request.created_at + 1,
      tags: [
        ['p', adminPk],
        ['e', poolId],
        ...(bolt11 === null ? [] : [['bolt11', bolt11]]),
        ['description', JSON.stringify(request)],
      ],
      content: '',
    },
    providerSk,
  )
}

describe('zap request shape', () => {
  it('leaves the content empty — clients render a plain zap, not a base64 blob', async () => {
    const template = await buildZapRequestTemplate({
      poolId,
      adminPubkey: adminPk,
      bettorPubkey: bettorPk,
      amountSats: 1000,
      relays: ['wss://relay.damus.io'],
      payload: { optionId: 'a', rewardAddress: encryptAddress('winner@wallet.com') },
      aesKey: generateAesKey(),
    })
    expect(template.content).toBe('')
    expect(template.tags.find((t) => t[0] === TAG_OPTION)?.[1]).toBeTruthy()
    expect(template.tags.find((t) => t[0] === TAG_ADDRESS)?.[1]).toBeTruthy()
    expect(template.tags).toContainEqual(BWF_VERSION_TAG)
  })

  it('bwf tags have constant sizes regardless of address length or option picked', async () => {
    const aesKey = generateAesKey()
    const optionLens = new Set<number>()
    const addressLens = new Set<number>()
    for (const [optionId, addr] of [
      ['a', 'a@b.io'],
      ['b', 'dana@walletofsatoshi.com'],
      ['c', 'dañá@wället.com'], // multi-byte characters
      ['d', 'x'.repeat(115) + '@ln.com'], // near the byte cap
    ] as const) {
      const template = await buildZapRequestTemplate({
        poolId,
        adminPubkey: adminPk,
        bettorPubkey: bettorPk,
        amountSats: 100_000,
        relays: ['wss://relay.damus.io'],
        payload: { optionId, rewardAddress: encryptAddress(addr) },
        aesKey,
      })
      optionLens.add(template.tags.find((t) => t[0] === TAG_OPTION)![1]!.length)
      addressLens.add(template.tags.find((t) => t[0] === TAG_ADDRESS)![1]!.length)
    }
    expect(optionLens.size).toBe(1)
    expect(addressLens.size).toBe(1)
  })
})

describe('reward address padding', () => {
  it('round-trips and always pads to the same byte length', () => {
    for (const addr of ['a@b.io', 'dana@walletofsatoshi.com', 'dañá@wället.com', 'x'.repeat(120) + '@ln.com']) {
      const padded = padRewardAddress(addr)
      expect(utf8Len(padded)).toBe(MAX_REWARD_ADDRESS_BYTES)
      expect(unpadRewardAddress(padded)).toBe(addr)
    }
  })

  it('rejects addresses of the cap byte length or more, measured in bytes', () => {
    expect(() => padRewardAddress('x'.repeat(122) + '@ln.io')).toThrow(/128/)
    // 64 two-byte chars: only 64 chars, but 128 bytes
    expect(() => padRewardAddress('é'.repeat(64))).toThrow(/128/)
    expect(padRewardAddress('é'.repeat(63))).toBeTruthy()
  })
})

describe('zap receipts as bets', () => {
  it('reconstructs a valid bet the admin can decrypt', async () => {
    const aesKey = generateAesKey()
    const receipt = await makeReceipt({ aesKey, amountSats: 2100 })
    const bet = await parseZapReceipt(receipt, { poolId, adminPubkey: adminPk, aesKey, providerPubkey: providerPk })
    expect(bet).not.toBeNull()
    expect(bet!.optionId).toBe('a')
    expect(bet!.amountSats).toBe(2100)
    expect(bet!.bettorPubkey).toBe(bettorPk)
    // The admin decrypts the recovered NIP-44 ciphertext with their own key.
    const address = nip44.decrypt(bet!.rewardAddress, nip44.getConversationKey(adminSk, bet!.bettorPubkey))
    expect(unpadRewardAddress(address)).toBe('winner@wallet.com')
  })

  it('rejects receipts whose invoice is missing, undecodable, or amountless', async () => {
    const aesKey = generateAesKey()
    const ctx = { poolId, adminPubkey: adminPk, aesKey, providerPubkey: providerPk }
    expect(await parseZapReceipt(await makeReceipt({ aesKey, bolt11: null }), ctx)).toBeNull()
    expect(await parseZapReceipt(await makeReceipt({ aesKey, bolt11: 'lnbc1mockinvoice' }), ctx)).toBeNull()
    const amountless = bech32.encode('lnbc', new Array(7 + 104).fill(0), 1023)
    expect(await parseZapReceipt(await makeReceipt({ aesKey, bolt11: amountless }), ctx)).toBeNull()
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

  it('rejects zaps whose tags are not encrypted with the pool key', async () => {
    const receipt = await makeReceipt({ aesKey: generateAesKey() })
    expect(
      await parseZapReceipt(receipt, { poolId, adminPubkey: adminPk, aesKey: generateAesKey(), providerPubkey: providerPk }),
    ).toBeNull()
  })

  it('rejects zap requests missing a bwf tag', async () => {
    const aesKey = generateAesKey()
    const original = await makeReceipt({ aesKey })
    const request = JSON.parse(original.tags.find((t) => t[0] === 'description')![1]!) as Event
    const stripped = finalizeEvent(
      {
        kind: request.kind,
        created_at: request.created_at,
        tags: request.tags.filter((t) => t[0] !== TAG_ADDRESS),
        content: request.content,
      },
      bettorSk,
    )
    expect(
      await parseZapReceipt(wrapInReceipt(stripped), { poolId, adminPubkey: adminPk, aesKey, providerPubkey: providerPk }),
    ).toBeNull()
  })

  it("rejects tags transplanted from another bettor's zap (AAD binding)", async () => {
    const aesKey = generateAesKey()
    const original = await makeReceipt({ aesKey })
    const originalRequest = JSON.parse(original.tags.find((t) => t[0] === 'description')![1]!) as Event
    // An attacker copies the encrypted tags into their own zap request without knowing the key.
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
    expect(
      await parseZapReceipt(wrapInReceipt(stolen), { poolId, adminPubkey: adminPk, aesKey, providerPubkey: providerPk }),
    ).toBeNull()
    // Sanity: the original, non-transplanted receipt still parses.
    expect(
      await parseZapReceipt(original, { poolId, adminPubkey: adminPk, aesKey, providerPubkey: providerPk }),
    ).not.toBeNull()
  })

  it('rejects a request whose bwf-option and bwf-address ciphertexts are swapped (per-tag AAD)', async () => {
    const aesKey = generateAesKey()
    const original = await makeReceipt({ aesKey })
    const request = JSON.parse(original.tags.find((t) => t[0] === 'description')![1]!) as Event
    const optionCt = request.tags.find((t) => t[0] === TAG_OPTION)![1]!
    const addressCt = request.tags.find((t) => t[0] === TAG_ADDRESS)![1]!
    const swapped = finalizeEvent(
      {
        kind: request.kind,
        created_at: request.created_at,
        tags: request.tags.map((t) =>
          t[0] === TAG_OPTION ? [TAG_OPTION, addressCt] : t[0] === TAG_ADDRESS ? [TAG_ADDRESS, optionCt] : t,
        ),
        content: request.content,
      },
      bettorSk,
    )
    expect(
      await parseZapReceipt(wrapInReceipt(swapped), { poolId, adminPubkey: adminPk, aesKey, providerPubkey: providerPk }),
    ).toBeNull()
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
        bettorPubkey: bettorPk,
        amountSats: 1_000_000, // claim a huge bet
        relays: ['wss://relay.damus.io'],
        payload: { optionId: 'a', rewardAddress: encryptAddress('attacker@wallet.com') },
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
