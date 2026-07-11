import type { EventTemplate, VerifiedEvent } from 'nostr-tools/core'
import type { WindowNostr } from 'nostr-tools/nip07'
import * as nip19 from 'nostr-tools/nip19'
import * as nip44 from 'nostr-tools/nip44'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

declare global {
  interface Window {
    nostr?: WindowNostr
  }
}

export type LoginMethod = 'extension' | 'nsec' | 'generated' | 'anonymous'

export interface Session {
  method: LoginMethod
  pubkey: string
  /** Present for all methods except 'extension' (keys held by the NIP-07 signer). */
  secretKey?: Uint8Array
}

const STORAGE_KEY = 'bwf.session'

export function hasExtension(): boolean {
  return typeof window !== 'undefined' && !!window.nostr
}

export async function loginWithExtension(): Promise<Session> {
  if (!window.nostr) throw new Error('No nostr extension found')
  // NIP-44 support is mandatory: reward addresses are encrypted to the admin
  // with it, and we refuse to fall back to weaker encryption.
  if (typeof window.nostr.nip44?.encrypt !== 'function' || typeof window.nostr.nip44?.decrypt !== 'function') {
    throw new Error(
      'Your nostr extension is too old — it lacks NIP-44 encryption, which BetWithFriends requires. Please update it or switch to an extension with NIP-44 support (e.g. a current Alby or nos2x).',
    )
  }
  const pubkey = await window.nostr.getPublicKey()
  const session: Session = { method: 'extension', pubkey }
  persist(session)
  return session
}

export function loginWithNsec(nsec: string): Session {
  const decoded = nip19.decode(nsec.trim())
  if (decoded.type !== 'nsec') throw new Error('Not a valid nsec')
  const secretKey = decoded.data
  const session: Session = { method: 'nsec', pubkey: getPublicKey(secretKey), secretKey }
  persist(session)
  return session
}

/** Creates fresh keys. The caller must show the nsec-backup warning for 'generated'. */
export function createNewKeys(method: 'generated' | 'anonymous'): Session {
  const secretKey = generateSecretKey()
  const session: Session = { method, pubkey: getPublicKey(secretKey), secretKey }
  persist(session)
  return session
}

/**
 * Throwaway keys for a single anonymous zap. Never persisted — the identity
 * lives only as long as the page, and does not log the user in.
 */
export function createEphemeralSession(): Session {
  const secretKey = generateSecretKey()
  return { method: 'anonymous', pubkey: getPublicKey(secretKey), secretKey }
}

export function nsecOf(session: Session): string | null {
  return session.secretKey ? nip19.nsecEncode(session.secretKey) : null
}

export function npubOf(session: Session): string {
  return nip19.npubEncode(session.pubkey)
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const stored = JSON.parse(raw) as { method: LoginMethod; pubkey: string; nsec?: string }
    if (stored.method === 'extension') {
      // The extension may be unavailable at startup; keep the pubkey and sign lazily.
      return { method: 'extension', pubkey: stored.pubkey }
    }
    if (!stored.nsec) return null
    const decoded = nip19.decode(stored.nsec)
    if (decoded.type !== 'nsec') return null
    return { method: stored.method, pubkey: getPublicKey(decoded.data), secretKey: decoded.data }
  } catch {
    return null
  }
}

export function logout(): void {
  localStorage.removeItem(STORAGE_KEY)
}

function persist(session: Session): void {
  const stored: { method: LoginMethod; pubkey: string; nsec?: string } = {
    method: session.method,
    pubkey: session.pubkey,
  }
  if (session.secretKey) stored.nsec = nip19.nsecEncode(session.secretKey)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
}

export async function signEvent(session: Session, template: EventTemplate): Promise<VerifiedEvent> {
  if (session.method === 'extension') {
    if (!window.nostr) throw new Error('Nostr extension is not available')
    const signed = await window.nostr.signEvent(template)
    if (signed.pubkey !== session.pubkey) {
      throw new Error('The extension signed with a different account — please log in again')
    }
    return signed
  }
  if (!session.secretKey) throw new Error('No secret key in session')
  return finalizeEvent(template, session.secretKey)
}

/**
 * NIP-44-encrypt to a recipient. Extensions without NIP-44 are rejected at
 * login, so this only fails if the extension denies or breaks at call time.
 */
export async function nip44EncryptTo(
  session: Session,
  recipientPubkey: string,
  plaintext: string,
): Promise<string> {
  if (session.method === 'extension') {
    if (!window.nostr?.nip44) throw new Error('Your nostr extension does not support NIP-44 encryption')
    return window.nostr.nip44.encrypt(recipientPubkey, plaintext)
  }
  if (!session.secretKey) throw new Error('No secret key in session')
  const key = nip44.getConversationKey(session.secretKey, recipientPubkey)
  return nip44.encrypt(plaintext, key)
}

export async function nip44DecryptFrom(
  session: Session,
  senderPubkey: string,
  ciphertext: string,
): Promise<string> {
  if (session.method === 'extension') {
    if (!window.nostr?.nip44) throw new Error('Your extension does not support NIP-44 decryption')
    return window.nostr.nip44.decrypt(senderPubkey, ciphertext)
  }
  if (!session.secretKey) throw new Error('No secret key in session')
  const key = nip44.getConversationKey(session.secretKey, senderPubkey)
  return nip44.decrypt(ciphertext, key)
}

const ANON_ADJECTIVES = [
  'Swift', 'Lucky', 'Sneaky', 'Brave', 'Cosmic', 'Golden', 'Silent', 'Wild',
  'Turbo', 'Mellow', 'Crimson', 'Frosty', 'Electric', 'Daring', 'Shadow', 'Neon',
]
const ANON_ANIMALS = [
  'Otter', 'Falcon', 'Badger', 'Lynx', 'Dolphin', 'Panther', 'Raccoon', 'Wolf',
  'Fox', 'Hawk', 'Tiger', 'Penguin', 'Moose', 'Cobra', 'Gecko', 'Walrus',
]

export function randomAnonName(): string {
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)]!
  return `${pick(ANON_ADJECTIVES)} ${pick(ANON_ANIMALS)}`
}
