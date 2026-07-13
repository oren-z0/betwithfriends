import type { Event, EventTemplate } from 'nostr-tools/core'
import { verifyEvent } from 'nostr-tools/pure'
import { aesDecryptBytes, aesEncryptBytes, base64ToBytes, bytesToBase64 } from '../crypto/aes'
import { bolt11AmountMsats } from '../lightning/lnurl'
import type { Bet, BetPayload } from '../types'
import { BWF_VERSION_TAG, KIND_ZAP_RECEIPT, KIND_ZAP_REQUEST } from '../types'

/**
 * The bet rides in two custom tags on the zap request, not in its content:
 *   bwf-option  — AES-GCM(pool key) of the option id
 *   bwf-address — AES-GCM(pool key) of the NIP-44(admin pubkey) ciphertext
 *                 of the NUL-padded reward address
 * Content stays empty so Nostr clients render a plain zap instead of a
 * base64 blob, and LNURL servers' commentAllowed limits (which apply to
 * content, not tags) no longer constrain the payload size.
 */
export const TAG_OPTION = 'bwf-option'
export const TAG_ADDRESS = 'bwf-address'

/**
 * Padded byte length of every reward address. 128 exactly fills a NIP-44
 * padding bucket, so together with the NUL padding every bwf-address tag
 * is the same size — ciphertext length reveals nothing about the address.
 */
export const MAX_REWARD_ADDRESS_BYTES = 128

/** Each tag's ciphertext is AAD-bound to its role and its author: copied into
 * someone else's zap request, or into the other tag's slot, it fails to
 * decrypt and the bet is ignored. */
function tagAad(tag: string, bettorPubkey: string): Uint8Array {
  return new TextEncoder().encode(`${tag}:${bettorPubkey}`)
}

/**
 * NUL-pads a reward address to exactly MAX_REWARD_ADDRESS_BYTES UTF-8 bytes
 * (NUL is one byte, so padding count = bytes missing). Applied before NIP-44
 * encryption. Addresses are measured in bytes, not chars — they may contain
 * multi-byte characters — and must leave room for at least one NUL.
 */
export function padRewardAddress(address: string): string {
  const byteLength = new TextEncoder().encode(address).length
  if (byteLength >= MAX_REWARD_ADDRESS_BYTES) {
    throw new Error(`Reward address must be under ${MAX_REWARD_ADDRESS_BYTES} bytes`)
  }
  return address + '\0'.repeat(MAX_REWARD_ADDRESS_BYTES - byteLength)
}

/** Inverse of padRewardAddress. */
export function unpadRewardAddress(address: string): string {
  return address.replace(/\0+$/, '')
}

/** Builds the NIP-57 zap request whose bwf-* tags carry the encrypted bet. */
export async function buildZapRequestTemplate(args: {
  poolId: string
  adminPubkey: string
  /** Pubkey that will sign this request — both tags are AAD-bound to it. */
  bettorPubkey: string
  amountSats: number
  relays: string[]
  payload: BetPayload
  aesKey: Uint8Array
}): Promise<EventTemplate> {
  if (!args.payload.optionId) throw new Error('Bad option id')
  const [optionCt, addressCt] = await Promise.all([
    aesEncryptBytes(
      args.aesKey,
      new TextEncoder().encode(args.payload.optionId),
      tagAad(TAG_OPTION, args.bettorPubkey),
    ),
    aesEncryptBytes(
      args.aesKey,
      base64ToBytes(args.payload.rewardAddress),
      tagAad(TAG_ADDRESS, args.bettorPubkey),
    ),
  ])
  return {
    kind: KIND_ZAP_REQUEST,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['relays', ...args.relays],
      ['amount', String(args.amountSats * 1000)],
      ['p', args.adminPubkey],
      ['e', args.poolId],
      [TAG_OPTION, bytesToBase64(optionCt)],
      [TAG_ADDRESS, bytesToBase64(addressCt)],
      BWF_VERSION_TAG,
    ],
    content: '',
  }
}

export interface ReceiptContext {
  poolId: string
  adminPubkey: string
  aesKey: Uint8Array
  /**
   * The admin's LNURL provider pubkey — required, not optional. Only that
   * key's signature proves a receipt came from the admin's own wallet, i.e.
   * that real sats were actually paid. Callers that don't know it yet MUST
   * NOT call this function with a placeholder — anyone could self-sign a
   * fake kind-9735 event claiming an arbitrary amount, and skipping this
   * check would let it through as a real bet.
   */
  providerPubkey: string
}

/**
 * Validates a kind-9735 zap receipt and reconstructs the bet it carries.
 * Returns null for anything that isn't a valid bet on this pool.
 */
export async function parseZapReceipt(receipt: Event, ctx: ReceiptContext): Promise<Bet | null> {
  if (receipt.kind !== KIND_ZAP_RECEIPT) return null
  if (receipt.pubkey !== ctx.providerPubkey) return null

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

  const optionCt = request.tags.find((t) => t[0] === TAG_OPTION)?.[1]
  const addressCt = request.tags.find((t) => t[0] === TAG_ADDRESS)?.[1]
  if (!optionCt || !addressCt) return null

  let optionId: string
  let rewardAddress: string
  try {
    optionId = new TextDecoder().decode(
      await aesDecryptBytes(ctx.aesKey, base64ToBytes(optionCt), tagAad(TAG_OPTION, request.pubkey)),
    )
    rewardAddress = bytesToBase64(
      await aesDecryptBytes(ctx.aesKey, base64ToBytes(addressCt), tagAad(TAG_ADDRESS, request.pubkey)),
    )
  } catch {
    return null
  }
  if (!optionId) return null

  return {
    receiptId: receipt.id,
    requestId: request.id,
    bettorPubkey: request.pubkey,
    optionId,
    amountSats: Math.floor(msats / 1000),
    rewardAddress,
    createdAt: request.created_at,
  }
}
