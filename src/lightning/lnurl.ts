import { bech32 } from '@scure/base'
import { decode as decodeBolt11 } from 'light-bolt11-decoder'

export interface LnurlPayParams {
  callback: string
  minSendable: number
  maxSendable: number
  metadata: string
  commentAllowed?: number
  allowsNostr?: boolean
  nostrPubkey?: string
}

/**
 * Exact size of our encrypted bet payload in the zap request content: the
 * reward address is capped at 63 chars and NUL-padded to exactly 63 before
 * NIP-44 encryption, so it always fills NIP-44's 64-byte padding bucket and
 * the binary-packed AES-GCM ciphertext is a constant 220 base64 chars —
 * under 255, the commentAllowed of the most popular wallets (Wallet of
 * Satoshi, Alby, Blink), and leaking nothing about the address length.
 */
export const BET_PAYLOAD_MAX_CHARS = 220
export const MAX_REWARD_ADDRESS_CHARS = 63

export function isLightningAddress(value: string): boolean {
  return /^[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,}|localhost(:\d+)?|127\.0\.0\.1(:\d+)?)$/i.test(value.trim())
}

/** LUD-16 lightning address → LNURL-pay endpoint URL (http for onion/local hosts, per LUD-16). */
export function lightningAddressToUrl(address: string): string {
  const [name, domain] = address.trim().split('@')
  if (!name || !domain) throw new Error('Invalid lightning address')
  const insecure = domain.endsWith('.onion') || domain.startsWith('localhost') || domain.startsWith('127.0.0.1')
  return `${insecure ? 'http' : 'https'}://${domain}/.well-known/lnurlp/${name}`
}

/** LUD-06 bech32 "lnurl1…" → endpoint URL. */
export function lud06ToUrl(lnurl: string): string {
  const { words } = bech32.decode(lnurl.toLowerCase() as `${string}1${string}`, 2000)
  return new TextDecoder().decode(bech32.fromWords(words))
}

export function resolveLnurlEndpoint(addressOrLnurl: string): string {
  const value = addressOrLnurl.trim()
  if (isLightningAddress(value)) return lightningAddressToUrl(value)
  if (value.toLowerCase().startsWith('lnurl1')) return lud06ToUrl(value)
  throw new Error('Enter a lightning address (name@wallet.com) or an LNURL')
}

export async function fetchPayParams(addressOrLnurl: string): Promise<LnurlPayParams> {
  const url = resolveLnurlEndpoint(addressOrLnurl)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Lightning wallet lookup failed (HTTP ${res.status})`)
  const data = (await res.json()) as Record<string, unknown>
  if (data.status === 'ERROR') throw new Error(`Lightning wallet error: ${data.reason ?? 'unknown'}`)
  if (data.tag !== 'payRequest' || typeof data.callback !== 'string') {
    throw new Error('This address does not support LNURL-pay')
  }
  return {
    callback: data.callback,
    minSendable: Number(data.minSendable ?? 1000),
    maxSendable: Number(data.maxSendable ?? Number.MAX_SAFE_INTEGER),
    metadata: typeof data.metadata === 'string' ? data.metadata : '',
    commentAllowed: typeof data.commentAllowed === 'number' ? data.commentAllowed : undefined,
    allowsNostr: data.allowsNostr === true,
    nostrPubkey: typeof data.nostrPubkey === 'string' ? data.nostrPubkey : undefined,
  }
}

/**
 * Checks whether the admin's wallet can host this pool's zaps: it must support
 * NIP-57 and must not enforce a comment limit smaller than our encrypted payload.
 */
export function checkZapSupport(params: LnurlPayParams): { ok: boolean; reason?: string } {
  if (!params.allowsNostr || !params.nostrPubkey) {
    return { ok: false, reason: 'This wallet does not support nostr zaps (NIP-57)' }
  }
  if (params.commentAllowed !== undefined && params.commentAllowed > 0 && params.commentAllowed < BET_PAYLOAD_MAX_CHARS) {
    return {
      ok: false,
      reason: `This wallet limits zap messages to ${params.commentAllowed} characters — too short for encrypted bets`,
    }
  }
  return { ok: true }
}

/** Requests a bolt11 invoice from an LNURL-pay callback. */
export async function requestInvoice(
  params: LnurlPayParams,
  amountMsats: number,
  zapRequestJson?: string,
): Promise<string> {
  if (amountMsats < params.minSendable || amountMsats > params.maxSendable) {
    throw new Error(
      `Amount must be between ${Math.ceil(params.minSendable / 1000)} and ${Math.floor(params.maxSendable / 1000)} sats for this wallet`,
    )
  }
  const url = new URL(params.callback)
  url.searchParams.set('amount', String(amountMsats))
  if (zapRequestJson) url.searchParams.set('nostr', zapRequestJson)
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`Invoice request failed (HTTP ${res.status})`)
  const data = (await res.json()) as Record<string, unknown>
  if (data.status === 'ERROR') throw new Error(`Invoice request rejected: ${data.reason ?? 'unknown'}`)
  if (typeof data.pr !== 'string') throw new Error('Wallet did not return an invoice')
  const invoiceMsats = bolt11AmountMsats(data.pr)
  if (invoiceMsats !== null && invoiceMsats !== amountMsats) {
    throw new Error('Wallet returned an invoice with a different amount — aborting')
  }
  return data.pr
}

/** Millisats encoded in a bolt11 invoice, or null when absent/undecodable. */
export function bolt11AmountMsats(invoice: string): number | null {
  try {
    const decoded = decodeBolt11(invoice)
    const section = decoded.sections.find((s: { name: string }) => s.name === 'amount') as
      | { name: string; value: string }
      | undefined
    return section ? Number(section.value) : null
  } catch {
    return null
  }
}
