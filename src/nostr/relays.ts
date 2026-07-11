import type { Event, EventTemplate } from 'nostr-tools/core'
import { SimplePool } from 'nostr-tools/pool'
import type { Profile } from '../types'

/** Overridable via VITE_DEFAULT_RELAYS (comma-separated) — used by the local E2E harness. */
export const DEFAULT_RELAYS: string[] = import.meta.env?.VITE_DEFAULT_RELAYS
  ? String(import.meta.env.VITE_DEFAULT_RELAYS).split(',')
  : ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band']

/** Publish to at most this many relays. */
export const MAX_PUBLISH_RELAYS = 8
/** Embed at most this many relay hints in the nevent, to keep share links short. */
export const MAX_NEVENT_HINTS = 3

export const pool = new SimplePool()

export function normalizeRelayUrl(url: string): string | null {
  let u = url.trim()
  if (!u) return null
  if (!/^wss?:\/\//.test(u)) u = 'wss://' + u
  try {
    const parsed = new URL(u)
    if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') return null
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

export function mergeRelays(...lists: string[][]): string[] {
  const seen = new Set<string>()
  for (const list of lists) {
    for (const raw of list) {
      const url = normalizeRelayUrl(raw)
      if (url) seen.add(url)
    }
  }
  return [...seen].slice(0, MAX_PUBLISH_RELAYS)
}

/** Publishes to all relays; resolves once at least one accepts, rejects if all fail. */
export async function publishToRelays(relays: string[], event: Event): Promise<string[]> {
  const results = await Promise.allSettled(pool.publish(relays, event))
  const ok = relays.filter((_, i) => results[i]?.status === 'fulfilled')
  if (ok.length === 0) {
    const firstError = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
    throw new Error(`No relay accepted the event: ${firstError?.reason ?? 'unknown error'}`)
  }
  return ok
}

export async function fetchEventById(id: string, relays: string[]): Promise<Event | null> {
  return pool.get(relays, { ids: [id] }, { maxWait: 6000 })
}

/** NIP-65 (kind 10002): the relays this pubkey writes to. */
export async function fetchWriteRelays(pubkey: string, relays: string[]): Promise<string[]> {
  const event = await pool.get(relays, { kinds: [10002], authors: [pubkey] }, { maxWait: 4000 })
  if (!event) return []
  return event.tags
    .filter((t) => t[0] === 'r' && t[1] && t[2] !== 'read')
    .map((t) => t[1] as string)
}

const profileCache = new Map<string, Profile>()

/** Newest kind-0 event for a pubkey. `pool.get` can return any relay's copy, so pick by created_at. */
async function fetchNewestProfileEvent(pubkey: string, relays: string[]): Promise<Event | null> {
  const events = await pool.querySync(relays, { kinds: [0], authors: [pubkey] }, { maxWait: 4000 })
  let newest: Event | null = null
  for (const ev of events) {
    if (!newest || ev.created_at > newest.created_at) newest = ev
  }
  return newest
}

export async function fetchProfile(pubkey: string, relays: string[]): Promise<Profile> {
  const cached = profileCache.get(pubkey)
  if (cached) return cached
  const profile = parseProfile(pubkey, await fetchNewestProfileEvent(pubkey, relays))
  profileCache.set(pubkey, profile)
  return profile
}

export async function fetchProfiles(pubkeys: string[], relays: string[]): Promise<Map<string, Profile>> {
  const missing = pubkeys.filter((p) => !profileCache.has(p))
  if (missing.length > 0) {
    const events = await pool.querySync(relays, { kinds: [0], authors: missing }, { maxWait: 5000 })
    // Keep only the newest kind-0 per author.
    const newest = new Map<string, Event>()
    for (const ev of events) {
      const prev = newest.get(ev.pubkey)
      if (!prev || ev.created_at > prev.created_at) newest.set(ev.pubkey, ev)
    }
    for (const pk of missing) profileCache.set(pk, parseProfile(pk, newest.get(pk) ?? null))
  }
  const out = new Map<string, Profile>()
  for (const pk of pubkeys) out.set(pk, profileCache.get(pk)!)
  return out
}

export function invalidateProfile(pubkey: string): void {
  profileCache.delete(pubkey)
}

function parseProfile(pubkey: string, event: Event | null): Profile {
  const profile: Profile = { pubkey }
  if (!event) return profile
  try {
    const meta = JSON.parse(event.content) as Record<string, unknown>
    if (typeof meta.name === 'string') profile.name = meta.name
    if (typeof meta.display_name === 'string' && meta.display_name) profile.name = meta.display_name
    if (typeof meta.picture === 'string') profile.picture = meta.picture
    if (typeof meta.lud16 === 'string') profile.lud16 = meta.lud16
    if (typeof meta.lud06 === 'string') profile.lud06 = meta.lud06
  } catch {
    // unparseable profile — leave defaults
  }
  return profile
}

/** The raw newest kind-0 for a pubkey (used to preserve fields when updating the profile). */
export async function fetchRawProfile(
  pubkey: string,
  relays: string[],
): Promise<{ content: Record<string, unknown>; createdAt: number }> {
  const event = await fetchNewestProfileEvent(pubkey, relays)
  if (!event) return { content: {}, createdAt: 0 }
  try {
    const parsed = JSON.parse(event.content)
    return {
      content: typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {},
      createdAt: event.created_at,
    }
  } catch {
    return { content: {}, createdAt: event.created_at }
  }
}

/** created_at must be strictly newer than the previous profile, or clients may keep the old one. */
export function buildProfileTemplate(content: Record<string, unknown>, prevCreatedAt = 0): EventTemplate {
  return {
    kind: 0,
    created_at: Math.max(Math.floor(Date.now() / 1000), prevCreatedAt + 1),
    tags: [],
    content: JSON.stringify(content),
  }
}
