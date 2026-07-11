import type { Bet, Payout } from './types'

export function totalPotSats(bets: Bet[]): number {
  return bets.reduce((sum, b) => sum + b.amountSats, 0)
}

export function totalsByOption(bets: Bet[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (const bet of bets) {
    totals.set(bet.optionId, (totals.get(bet.optionId) ?? 0) + bet.amountSats)
  }
  return totals
}

/**
 * Each winner receives their share of the whole pot (minus the admin fee),
 * proportional to their stake among the winning bets:
 *   payout = stake / Σ(winning stakes) × pot × (1 − fee%)
 * Amounts are floored to whole sats, so rounding dust stays with the admin.
 */
export function computePayouts(bets: Bet[], winningOptionId: string, adminFeePct: number): Payout[] {
  const pot = totalPotSats(bets)
  const winners = bets.filter((b) => b.optionId === winningOptionId)
  const winningStake = totalPotSats(winners)
  if (winningStake === 0) return []
  const distributable = pot * (1 - adminFeePct / 100)
  return winners.map((bet) => ({
    bet,
    amountSats: Math.floor((bet.amountSats / winningStake) * distributable),
    paid: false,
  }))
}

/**
 * Refunds for a cancelled pool: every bet is returned to its bettor minus the
 * admin fee (which covers the admin's lightning costs for paying refunds).
 * One refund per bet, so a bettor with several bets gets several refunds —
 * summing to their total stake × (1 − fee%).
 */
export function computeRefunds(bets: Bet[], adminFeePct: number): Payout[] {
  return bets.map((bet) => ({
    bet,
    amountSats: Math.floor(bet.amountSats * (1 - adminFeePct / 100)),
    paid: false,
  }))
}
