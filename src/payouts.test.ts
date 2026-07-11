import { describe, expect, it } from 'vitest'
import { computePayouts, computeRefunds, totalPotSats, totalsByOption } from './payouts'
import type { Bet } from './types'

function bet(optionId: string, amountSats: number, id = Math.random().toString(36)): Bet {
  return {
    receiptId: id,
    requestId: 'req-' + id,
    bettorPubkey: 'pk-' + id,
    optionId,
    amountSats,
    rewardAddress: 'plain:x@y.com',
    createdAt: 0,
  }
}

describe('payouts', () => {
  it('sums pot and per-option totals', () => {
    const bets = [bet('a', 100), bet('a', 50), bet('b', 200)]
    expect(totalPotSats(bets)).toBe(350)
    expect(totalsByOption(bets).get('a')).toBe(150)
    expect(totalsByOption(bets).get('b')).toBe(200)
  })

  it('splits the pot proportionally among winners after the fee', () => {
    const bets = [bet('a', 100), bet('a', 300), bet('b', 600)]
    const payouts = computePayouts(bets, 'a', 2)
    // pot=1000, fee 2% → 980 distributable; stakes 100:300 of 400
    expect(payouts.map((p) => p.amountSats)).toEqual([245, 735])
  })

  it('with 0% fee winners share exactly the pot', () => {
    const bets = [bet('a', 1), bet('a', 2), bet('b', 7)]
    const payouts = computePayouts(bets, 'a', 0)
    expect(payouts.reduce((s, p) => s + p.amountSats, 0)).toBeLessThanOrEqual(10)
    expect(payouts.map((p) => p.amountSats)).toEqual([3, 6]) // 1/3 and 2/3 of 10, floored
  })

  it('floors fractional sats (dust stays with the admin)', () => {
    const bets = [bet('a', 1), bet('a', 1), bet('a', 1), bet('b', 7)]
    const payouts = computePayouts(bets, 'a', 5)
    // pot=10, distributable=9.5, each winner gets 9.5/3 = 3.1666 → 3
    expect(payouts.map((p) => p.amountSats)).toEqual([3, 3, 3])
  })

  it('returns empty when nobody bet on the winning option', () => {
    expect(computePayouts([bet('b', 100)], 'a', 2)).toEqual([])
  })

  it('a single winner takes the whole pot minus fee', () => {
    const bets = [bet('a', 250), bet('b', 750)]
    const payouts = computePayouts(bets, 'a', 2)
    expect(payouts).toHaveLength(1)
    expect(payouts[0]!.amountSats).toBe(980)
  })
})

describe('refunds (cancelled pool)', () => {
  it('refunds every bet minus the admin fee', () => {
    const bets = [bet('a', 1000), bet('b', 500)]
    const refunds = computeRefunds(bets, 2)
    expect(refunds.map((r) => r.amountSats)).toEqual([980, 490])
  })

  it('a bettor with several bets gets each refunded separately', () => {
    const bets = [bet('a', 300, 'r1'), bet('b', 700, 'r2')]
    const refunds = computeRefunds(bets, 10)
    expect(refunds.map((r) => r.bet.receiptId)).toEqual(['r1', 'r2'])
    expect(refunds.map((r) => r.amountSats)).toEqual([270, 630])
  })

  it('floors fractional sats and handles 0% fee', () => {
    expect(computeRefunds([bet('a', 333)], 1).map((r) => r.amountSats)).toEqual([329]) // 329.67 → 329
    expect(computeRefunds([bet('a', 333)], 0).map((r) => r.amountSats)).toEqual([333])
    expect(computeRefunds([], 2)).toEqual([])
  })
})
