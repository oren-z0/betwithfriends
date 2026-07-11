import type { Event, EventTemplate } from 'nostr-tools/core'
import { verifyEvent } from 'nostr-tools/pure'
import { aesDecryptBytes, aesEncryptBytes, base64ToBytes, bytesToBase64 } from '../crypto/aes'
import { bolt11AmountMsats, MAX_REWARD_ADDRESS_CHARS } from '../lightning/lnurl'
import type { Bet, BetPayload } from '../types'
import { KIND_ZAP_RECEIPT, KIND_ZAP_REQUEST } from '../types'

/**
 * Compact binary encoding of the bet payload. Zap content must stay within
 * LNURL servers' comment limits (commentAllowed is 255 for most popular
 * wallets), so instead of JSON with base64-inside-base64 we pack raw bytes:
 *   [version=1][optionId length][optionId utf8][mode][address bytes]
 * where mode 1 = raw NIP-44 ciphertext bytes (admin-only), 0 = plain utf8.
 * Typical result after AES+base64: ~170 chars (~215 for a 64-char address).
 */
const PAYLOAD_VERSION = 1
const MODE_PLAIN = 0
const MODE_NIP44 = 1

export function encodeBetPayload(payload: BetPayload): Uint8Array {
  const optionId = new TextEncoder().encode(payload.optionId)
  if (optionId.length < 1 || optionId.length > 255) throw new Error('Bad option id')
  let mode: number
  let address: Uint8Array
  if (payload.rewardAddress.startsWith('nip44:')) {
    mode = MODE_NIP44
    address = base64ToBytes(payload.rewardAddress.slice('nip44:'.length))
  } else if (payload.rewardAddress.startsWith('plain:')) {
    mode = MODE_PLAIN
    address = new TextEncoder().encode(payload.rewardAddress.slice('plain:'.length))
  } else {
    throw new Error('Unrecognized reward address format')
  }
  const out = new Uint8Array(3 + optionId.length + address.length)
  out[0] = PAYLOAD_VERSION
  out[1] = optionId.length
  out.set(optionId, 2)
  out[2 + optionId.length] = mode
  out.set(address, 3 + optionId.length)
  return out
}

export function decodeBetPayload(bytes: Uint8Array): BetPayload | null {
  if (bytes.length < 4 || bytes[0] !== PAYLOAD_VERSION) return null
  const optLen = bytes[1]!
  if (bytes.length < 3 + optLen + 1) return null
  const optionId = new TextDecoder().decode(bytes.slice(2, 2 + optLen))
  const mode = bytes[2 + optLen]
  const address = bytes.slice(3 + optLen)
  if (mode === MODE_NIP44) return { optionId, rewardAddress: `nip44:${bytesToBase64(address)}` }
  if (mode === MODE_PLAIN) return { optionId, rewardAddress: `plain:${new TextDecoder().decode(address)}` }
  return null
}

/** The bettor's pubkey as AAD binds each bet payload to its author: a payload
 * copied into someone else's zap request fails to decrypt and is ignored. */
function bettorAad(pubkey: string): Uint8Array {
  return new TextEncoder().encode(`bwf-bet:${pubkey}`)
}

/**
 * NUL-pads a reward address to the fixed MAX_REWARD_ADDRESS_CHARS length so
 * every encrypted bet payload has the same size — ciphertext length reveals
 * nothing about the address. Applied before NIP-44 (or plain) encoding.
 */
export function padRewardAddress(address: string): string {
  if (address.length > MAX_REWARD_ADDRESS_CHARS) {
    throw new Error(`Reward address must be at most ${MAX_REWARD_ADDRESS_CHARS} characters`)
  }
  return address.padEnd(MAX_REWARD_ADDRESS_CHARS, '\0')
}

/** Inverse of padRewardAddress. */
export function unpadRewardAddress(address: string): string {
  return address.replace(/\0+$/, '')
}

/** Builds the NIP-57 zap request whose content carries the encrypted bet. */
export async function buildZapRequestTemplate(args: {
  poolId: string
  adminPubkey: string
  /** Pubkey that will sign this request — the payload is AAD-bound to it. */
  bettorPubkey: string
  amountSats: number
  relays: string[]
  payload: BetPayload
  aesKey: Uint8Array
}): Promise<EventTemplate> {
  return {
    kind: KIND_ZAP_REQUEST,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['relays', ...args.relays],
      ['amount', String(args.amountSats * 1000)],
      ['p', args.adminPubkey],
      ['e', args.poolId],
    ],
    content: bytesToBase64(
      await aesEncryptBytes(args.aesKey, encodeBetPayload(args.payload), bettorAad(args.bettorPubkey)),
    ),
  }
}

export interface ReceiptContext {
  poolId: string
  adminPubkey: string
  aesKey: Uint8Array
  /** The admin's LNURL provider pubkey; when known, receipts from other signers are rejected. */
  providerPubkey?: string
}

/**
 * Validates a kind-9735 zap receipt and reconstructs the bet it carries.
 * Returns null for anything that isn't a valid bet on this pool.
 */
export async function parseZapReceipt(receipt: Event, ctx: ReceiptContext): Promise<Bet | null> {
  if (receipt.kind !== KIND_ZAP_RECEIPT) return null
  if (ctx.providerPubkey && receipt.pubkey !== ctx.providerPubkey) return null

  const description = receipt.tags.find((t) => t[0] === 'description')?.[1]
  if (!description) return null

  let request: Event
  try {
    request = JSON.parse(description) as Event
  } catch {
    return null
  }
  if (request.kind !== KIND_ZAP_REQUEST) return null
  if (!verifyEvent(request)) return null
  if (!request.tags.some((t) => t[0] === 'e' && t[1] === ctx.poolId)) return null
  if (!request.tags.some((t) => t[0] === 'p' && t[1] === ctx.adminPubkey)) return null

  // The paid amount comes from the invoice; fall back to the requested amount tag.
  const bolt11 = receipt.tags.find((t) => t[0] === 'bolt11')?.[1]
  let msats = bolt11 ? bolt11AmountMsats(bolt11) : null
  if (msats === null) {
    const amountTag = request.tags.find((t) => t[0] === 'amount')?.[1]
    msats = amountTag ? Number(amountTag) : null
  }
  if (!msats || !Number.isFinite(msats) || msats <= 0) return null

  let payload: BetPayload | null
  try {
    payload = decodeBetPayload(
      await aesDecryptBytes(ctx.aesKey, base64ToBytes(request.content), bettorAad(request.pubkey)),
    )
  } catch {
    return null
  }
  if (!payload) return null

  return {
    receiptId: receipt.id,
    requestId: request.id,
    bettorPubkey: request.pubkey,
    optionId: payload.optionId,
    amountSats: Math.floor(msats / 1000),
    rewardAddress: payload.rewardAddress,
    createdAt: request.created_at,
  }
}
