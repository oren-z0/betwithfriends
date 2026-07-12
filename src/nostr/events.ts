import type { Event, EventTemplate } from 'nostr-tools/core'
import * as nip19 from 'nostr-tools/nip19'
import { aesDecrypt, aesEncrypt, base64UrlToBytes, bytesToBase64Url } from '../crypto/aes'
import type { AdminAction, Pool, PoolComment, PoolContent } from '../types'
import { BWF_VERSION_TAG, KIND_ADMIN_ACTION, KIND_COMMENT, KIND_POOL } from '../types'
import { MAX_NEVENT_HINTS } from './relays'

const ALT_TAG = ['alt', 'Encrypted BetWithFriends event — see https://betwithfriends.niot.space']

function now(): number {
  return Math.floor(Date.now() / 1000)
}

export async function buildPoolTemplate(content: PoolContent, aesKey: Uint8Array): Promise<EventTemplate> {
  validatePoolContent(content)
  return {
    kind: KIND_POOL,
    created_at: now(),
    tags: [ALT_TAG, BWF_VERSION_TAG],
    content: await aesEncrypt(aesKey, JSON.stringify(content)),
  }
}

export async function parsePoolEvent(event: Event, aesKey: Uint8Array, relays: string[]): Promise<Pool> {
  if (event.kind !== KIND_POOL) throw new Error('Not a betting pool event')
  let content: PoolContent
  try {
    content = JSON.parse(await aesDecrypt(aesKey, event.content)) as PoolContent
  } catch {
    throw new Error('Could not decrypt the pool — the link may be corrupted or incomplete')
  }
  validatePoolContent(content)
  return {
    id: event.id,
    adminPubkey: event.pubkey,
    createdAt: event.created_at,
    relays,
    content,
  }
}

export function validatePoolContent(content: PoolContent): void {
  if (content.v !== 1) throw new Error('Unsupported pool version')
  if (typeof content.title !== 'string' || !content.title.trim()) throw new Error('Title is required')
  if (!Array.isArray(content.options) || content.options.length < 2) {
    throw new Error('At least 2 options are required')
  }
  const ids = new Set<string>()
  for (const option of content.options) {
    if (typeof option.id !== 'string' || !option.id) throw new Error('Option is missing an id')
    if (typeof option.title !== 'string' || !option.title.trim()) throw new Error('Every option needs a title')
    if (ids.has(option.id)) throw new Error('Duplicate option id')
    ids.add(option.id)
  }
  if (!Number.isFinite(content.adminFeePct) || content.adminFeePct < 0 || content.adminFeePct > 100) {
    throw new Error('Admin fee must be between 0 and 100')
  }
  if (!Number.isInteger(content.maxBets) || content.maxBets < 1) throw new Error('Max bets must be at least 1')
  if (!Number.isInteger(content.maxBetSats) || content.maxBetSats < 1) {
    throw new Error('Max bet amount must be at least 1 sat')
  }
  if (content.deadline !== undefined && !Number.isFinite(content.deadline)) {
    throw new Error('Invalid deadline')
  }
}

export async function buildAdminActionTemplate(
  poolId: string,
  action: AdminAction,
  aesKey: Uint8Array,
): Promise<EventTemplate> {
  return {
    kind: KIND_ADMIN_ACTION,
    created_at: now(),
    tags: [['e', poolId], ALT_TAG, BWF_VERSION_TAG],
    content: await aesEncrypt(aesKey, JSON.stringify(action)),
  }
}

export interface PoolStatus {
  closed: boolean
  winnerOptionId: string | null
  cancelled: boolean
  paidReceiptIds: Set<string>
}

/**
 * Folds admin-action events into the pool status. Only events signed by the
 * pool's admin count. Events fold chronologically, so the newest settlement
 * decision (winner vs cancel) wins and paid/unpaid toggles keep their latest
 * state per receipt.
 */
export async function foldAdminActions(
  events: Event[],
  pool: Pool,
  aesKey: Uint8Array,
): Promise<PoolStatus> {
  const status: PoolStatus = { closed: false, winnerOptionId: null, cancelled: false, paidReceiptIds: new Set() }
  const valid: { event: Event; action: AdminAction }[] = []
  for (const event of events) {
    if (event.kind !== KIND_ADMIN_ACTION) continue
    if (event.pubkey !== pool.adminPubkey) continue
    if (!event.tags.some((t) => t[0] === 'e' && t[1] === pool.id)) continue
    try {
      valid.push({ event, action: JSON.parse(await aesDecrypt(aesKey, event.content)) as AdminAction })
    } catch {
      // not decryptable with this pool's key — ignore
    }
  }
  valid.sort((a, b) => a.event.created_at - b.event.created_at || a.event.id.localeCompare(b.event.id))
  for (const { action } of valid) {
    if (action.action === 'close') status.closed = true
    else if (action.action === 'winner' && typeof action.optionId === 'string') {
      status.winnerOptionId = action.optionId
      status.cancelled = false
      status.closed = true
    } else if (action.action === 'cancel') {
      status.cancelled = true
      status.winnerOptionId = null
      status.closed = true
    } else if (action.action === 'paid' && typeof action.receiptId === 'string') {
      status.paidReceiptIds.add(action.receiptId)
    } else if (action.action === 'unpaid' && typeof action.receiptId === 'string') {
      status.paidReceiptIds.delete(action.receiptId)
    }
  }
  return status
}

export async function buildCommentTemplate(
  poolId: string,
  text: string,
  aesKey: Uint8Array,
): Promise<EventTemplate> {
  return {
    kind: KIND_COMMENT,
    created_at: now(),
    tags: [['e', poolId], ALT_TAG, BWF_VERSION_TAG],
    content: await aesEncrypt(aesKey, JSON.stringify({ text })),
  }
}

export async function parseComment(event: Event, aesKey: Uint8Array): Promise<PoolComment | null> {
  if (event.kind !== KIND_COMMENT) return null
  try {
    const { text } = JSON.parse(await aesDecrypt(aesKey, event.content)) as { text: string }
    if (typeof text !== 'string' || !text.trim()) return null
    return { id: event.id, authorPubkey: event.pubkey, createdAt: event.created_at, text }
  } catch {
    return null
  }
}

export interface ShareRef {
  poolId: string
  adminPubkey?: string
  relays: string[]
  aesKey: Uint8Array
}

/** Builds the "#/p/<nevent>/<key>" hash fragment for a pool's share link. */
export function buildShareHash(ref: {
  poolId: string
  adminPubkey: string
  relays: string[]
  aesKey: Uint8Array
}): string {
  const nevent = nip19.neventEncode({
    id: ref.poolId,
    author: ref.adminPubkey,
    kind: KIND_POOL,
    relays: ref.relays.slice(0, MAX_NEVENT_HINTS),
  })
  return `#/p/${nevent}/${bytesToBase64Url(ref.aesKey)}`
}

export function parseShareHash(hash: string): ShareRef | null {
  const match = /^#\/p\/(nevent1[a-z0-9]+)\/([A-Za-z0-9_-]+)$/.exec(hash)
  if (!match) return null
  try {
    const decoded = nip19.decode(match[1]!)
    if (decoded.type !== 'nevent') return null
    const aesKey = base64UrlToBytes(match[2]!)
    if (aesKey.length !== 32) return null
    // Reject non-canonical encodings (base64's 2 trailing padding bits), so
    // every pool has exactly one valid link and any URL edit visibly fails.
    if (bytesToBase64Url(aesKey) !== match[2]!) return null
    return {
      poolId: decoded.data.id,
      adminPubkey: decoded.data.author,
      relays: decoded.data.relays ?? [],
      aesKey,
    }
  } catch {
    return null
  }
}
