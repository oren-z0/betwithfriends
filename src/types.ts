export interface BetOption {
  id: string
  title: string
  description?: string
}

/** Decrypted content of a pool event (kind 8880). */
export interface PoolContent {
  v: 1
  title: string
  description?: string
  imageUrl?: string
  backgroundUrl?: string
  options: BetOption[]
  adminFeePct: number
  maxBets: number
  maxBetSats: number
  /** Unix seconds. Bets are blocked (in the UI) after this time. */
  deadline?: number
}

/** A pool as loaded from a relay: the event envelope plus decrypted content. */
export interface Pool {
  id: string
  adminPubkey: string
  createdAt: number
  relays: string[]
  content: PoolContent
}

/** Decrypted content of a zap request placed as a bet. */
export interface BetPayload {
  optionId: string
  /**
   * The bettor's lightning address for receiving winnings, NUL-padded to a
   * fixed length. "nip44:<ciphertext>" — encrypted to the admin's pubkey
   * (only admin can read). The wire format also allows "plain:<address>",
   * kept for decoding robustness; the app never produces it (extensions
   * without NIP-44 are rejected at login).
   */
  rewardAddress: string
}

/** A validated bet reconstructed from a zap receipt. */
export interface Bet {
  receiptId: string
  /** Id of the embedded zap request — lets a bettor recognize their own pending zap. */
  requestId: string
  bettorPubkey: string
  optionId: string
  amountSats: number
  rewardAddress: string
  createdAt: number
}

export type AdminAction =
  | { action: 'close' }
  | { action: 'winner'; optionId: string }
  | { action: 'cancel' }
  | { action: 'paid' | 'unpaid'; receiptId: string }

export interface PoolComment {
  id: string
  authorPubkey: string
  createdAt: number
  text: string
}

export interface Profile {
  pubkey: string
  name?: string
  picture?: string
  lud16?: string
  lud06?: string
}

export interface Payout {
  bet: Bet
  amountSats: number
  paid: boolean
}

// App-defined kinds: the 888x block ("regular event" range, unclaimed in the
// NIPs and community kind registries as of 2026-07) — 888 for luck.
export const KIND_POOL = 8880
export const KIND_ADMIN_ACTION = 8881
export const KIND_COMMENT = 8882
export const KIND_ZAP_REQUEST = 9734
export const KIND_ZAP_RECEIPT = 9735

export const DEFAULTS = {
  adminFeePct: 2,
  maxBets: 20,
  maxBetSats: 100_000,
} as const
