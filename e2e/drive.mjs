// Drives the full BetWithFriends flow against the local harness (e2e/harness.mjs)
// and a Vite dev server started with VITE_DEFAULT_RELAYS=ws://localhost:7777.
// Usage: node e2e/drive.mjs [screenshot-dir]
import { chromium } from 'playwright'

const BASE = 'http://localhost:5199/'
const SHOTS = process.argv[2] ?? 'e2e/shots'
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }

const step = (msg) => console.log('STEP:', msg)
const shot = async (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false })

async function acceptDisclaimer(page) {
  await page.getByRole('button', { name: 'I understand & agree' }).click()
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  // ---------------- admin: create the pool ----------------
  const admin = await browser.newContext(MOBILE)
  const a = await admin.newPage()
  a.on('dialog', (d) => d.accept())
  a.on('pageerror', (e) => console.log('ADMIN PAGEERROR:', e.message))

  await a.goto(BASE)
  step('disclaimer shown on first visit')
  await a.getByText('Before you continue').waitFor()
  await shot(a, '01-disclaimer')
  await acceptDisclaimer(a)
  step('hero visible')
  await a.getByText('Friendly bets').waitFor()
  await shot(a, '02-hero')

  await a.getByRole('link', { name: 'Create a betting pool' }).click()
  await a.getByRole('button', { name: 'Log in / create a profile' }).click()
  await a.getByRole('button', { name: '✨ Create a new nostr profile' }).click()
  await a.getByPlaceholder('e.g. Dana').fill('TestAdmin')
  await a.getByRole('button', { name: 'Create profile' }).click()
  step('nsec backup gate')
  await a.getByText('Back up your secret key').waitFor()
  const nsecShown = (await a.locator('.modal .mono').first().innerText()).startsWith('nsec1')
  console.log('CHECK nsec shown:', nsecShown)
  await shot(a, '03-backup')
  const cont = a.getByRole('button', { name: 'Continue' })
  console.log('CHECK continue disabled before confirm:', await cont.isDisabled())
  await a.getByText('I saved my nsec somewhere safe').click()
  await cont.click()

  step('wallet check: profile has no lightning address')
  await a.getByText('no lightning address').waitFor()
  await shot(a, '04-wallet-missing')
  await a.getByPlaceholder('you@walletofsatoshi.com').fill('admin@localhost:7778')
  await a.getByRole('button', { name: 'Save to my profile' }).click()
  await a.getByText('Bets will be zapped to').waitFor({ timeout: 15000 })
  step('wallet verified (allowsNostr ok)')

  await a.getByPlaceholder('Who wins the Champions League final?').fill('Who wins the derby?')
  await a.getByPlaceholder('Details, rules, kickoff time…').fill('Loser buys pizza. Kickoff Sunday 20:00.')
  const optionTitle = (page, i) => page.locator('.option-edit').nth(i).locator('input').first()
  await optionTitle(a, 0).fill('Maccabi')
  await optionTitle(a, 1).fill('Hapoel')
  await a.locator('.bg-tile', { hasText: 'Football' }).first().click()
  const deadline = new Date(Date.now() + 2 * 3600 * 1000)
  const local = new Date(deadline.getTime() - deadline.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  await a.locator('input[type="datetime-local"]').fill(local)
  await shot(a, '05-create-form')
  await a.getByRole('button', { name: 'Create pool' }).click()
  step('pool published — lands directly on the pool page')
  await a.getByText('Who wins the derby?').waitFor({ timeout: 15000 })
  const link = a.url()
  console.log('POOL LINK:', link)
  console.log('CHECK share link in URL:', /#\/p\/nevent1/.test(link))
  await shot(a, '06-created')

  // ---------------- bettor: place a bet anonymously ----------------
  const bettor = await browser.newContext(MOBILE)
  const b = await bettor.newPage()
  b.on('pageerror', (e) => console.log('BETTOR PAGEERROR:', e.message))
  await b.goto(link)
  await acceptDisclaimer(b)
  step('bettor sees the pool')
  await b.getByText('Who wins the derby?').waitFor({ timeout: 15000 })
  await b.getByText('Pool by TestAdmin').waitFor({ timeout: 10000 })
  console.log('CHECK bettor has no comment form:', (await b.getByPlaceholder('Write a comment…').count()) === 0)
  console.log('CHECK empty comments card hidden from bettor:', (await b.getByText('Admin Comments').count()) === 0)
  await shot(b, '07-pool-view')

  await b.getByRole('button', { name: /Maccabi/ }).click()
  step('anonymous identity minted automatically, no login menu')
  await b.getByText('Bet on “Maccabi”').waitFor({ timeout: 15000 })
  console.log('CHECK zapping-as subtitle:', await b.getByText(/Zapping as/).isVisible())
  console.log('CHECK still not logged in (topbar):', await b.getByRole('button', { name: 'Log in', exact: true }).isVisible())
  await shot(b, '08-bet-anon')

  // 🔍 probe: "Log in instead" opens a login-only menu (no anonymous option), cancel resumes anon betting
  await b.getByRole('button', { name: 'Log in instead' }).click()
  await b.getByText('Log in to bet').waitFor()
  console.log('CHECK no anon option in login menu:', (await b.getByText('Zap as a new anonymous user').count()) === 0)
  await b.getByRole('button', { name: 'Cancel' }).click()
  await b.getByRole('button', { name: /Maccabi/ }).click()
  await b.getByText('Bet on “Maccabi”').waitFor({ timeout: 5000 })
  step('anon identity reused after cancelling login switch')

  // 🔍 probe: over the max bet
  await b.getByPlaceholder(/up to/).fill('200000')
  await b.getByPlaceholder('you@walletofsatoshi.com').fill('winner@localhost:7778')
  await b.getByRole('button', { name: /Get invoice/ }).click()
  const overMaxError = await b.locator('.error').first().innerText()
  console.log('CHECK over-max error:', overMaxError)

  // 🔍 probe: bad reward address
  await b.getByPlaceholder(/up to/).fill('1000')
  await b.getByPlaceholder('you@walletofsatoshi.com').fill('not-an-address')
  await b.getByRole('button', { name: /Get invoice/ }).click()
  const badAddrError = await b.locator('.error').first().innerText()
  console.log('CHECK bad-address error:', badAddrError)

  // happy path
  await b.getByPlaceholder('you@walletofsatoshi.com').fill('winner@localhost:7778')
  await b.getByRole('button', { name: /Get invoice/ }).click()
  step('invoice shown')
  await b.getByText('Pay to place your bet').waitFor({ timeout: 15000 })
  await shot(b, '09-invoice')
  step('waiting for zap receipt…')
  await b.getByText('Your bet is in!').waitFor({ timeout: 20000 })
  await shot(b, '10-paid')
  await b.getByRole('button', { name: 'Done' }).click()
  await b.getByText('Pot: 1,000 sats').waitFor({ timeout: 10000 })
  step('pot updated to 1,000 sats on bettor page')

  // same (now logged-in anonymous) bettor bets on the other option too
  await b.getByRole('button', { name: /Hapoel/ }).click()
  await b.getByText('Bet on “Hapoel”').waitFor()
  await b.getByPlaceholder(/up to/).fill('500')
  await b.getByPlaceholder('you@walletofsatoshi.com').fill('winner@localhost:7778')
  await b.getByRole('button', { name: /Get invoice/ }).click()
  await b.getByText('Your bet is in!').waitFor({ timeout: 20000 })
  await b.getByRole('button', { name: 'Done' }).click()
  await b.getByText('Pot: 1,500 sats').waitFor({ timeout: 10000 })
  step('second bet placed, pot 1,500 sats')
  await shot(b, '11-two-bets')

  // ---------------- admin: watch, comment, settle ----------------
  await a.goto(link)
  await a.getByText('Who wins the derby?').waitFor({ timeout: 15000 })
  await a.getByText('Pot: 1,500 sats').waitFor({ timeout: 10000 })
  step('admin sees live bets and admin panel')
  await a.getByText('Admin', { exact: true }).waitFor()
  await a.getByText('winner@localhost:7778').first().waitFor({ timeout: 10000 })
  console.log('CHECK admin zap rows (per-line, date + reward address):', (await a.locator('.option .bet-row').count()) === 2)

  await a.getByPlaceholder('Write a comment…').fill('Kickoff moved to 20:30!')
  await a.getByRole('button', { name: 'Post' }).click()
  await a.getByText('Kickoff moved to 20:30!').waitFor({ timeout: 10000 })
  console.log('CHECK comments card titled Admin Comments:', await a.getByText('Admin Comments').isVisible())
  console.log('CHECK comment shows only date+text (no author):', (await a.locator('.comment .meta').innerText()).match(/^\w{3} \d/) !== null)

  // 🔍 probe: a comment forged by a non-admin, published straight to the relay, must not appear
  const { finalizeEvent: fe, generateSecretKey: gsk } = await import('nostr-tools/pure')
  const nip19 = await import('nostr-tools/nip19')
  const { WebSocket: WS } = await import('ws')
  const poolIdHex = nip19.decode(link.match(/nevent1[a-z0-9]+/)[0]).data.id
  const forged = fe(
    { kind: 8882, created_at: Math.floor(Date.now() / 1000), tags: [['e', poolIdHex]], content: 'forged comment' },
    gsk(),
  )
  await new Promise((resolve) => {
    const ws = new WS('ws://localhost:7777')
    ws.on('open', () => {
      ws.send(JSON.stringify(['EVENT', forged]))
      setTimeout(() => { ws.close(); resolve() }, 300)
    })
  })
  await a.waitForTimeout(1500)
  console.log('CHECK forged non-admin comment not shown:', (await a.locator('.comment').count()) === 1)
  await shot(a, '12-admin-panel')

  await a.locator('select').selectOption({ label: 'Maccabi' })
  await a.getByRole('button', { name: 'Declare winner' }).click()
  step('winner declared')
  await a.getByText(/Payouts — Maccabi won/).waitFor({ timeout: 10000 })
  const payoutAmt = await a.locator('.payout-row .amt').first().innerText()
  console.log('CHECK payout amount (expect 1,470):', payoutAmt)
  await shot(a, '13-payouts')

  await a.getByRole('button', { name: 'Pay', exact: true }).click()
  step('payout invoice from winner wallet')
  await a.locator('.modal').getByText('winner@localhost:7778').waitFor({ timeout: 15000 })
  await a.locator('.qr-wrap img').waitFor({ timeout: 15000 })
  await shot(a, '14-payout-invoice')
  await a.getByRole('button', { name: 'Mark paid & close' }).click()
  await a.locator('.payout-row.paid').waitFor({ timeout: 10000 })
  step('winner marked paid')
  await shot(a, '15-paid-marked')

  // bettor side: betting should now be blocked with the settled status
  await b.getByText('This pool has been settled').waitFor({ timeout: 10000 })
  const optionDisabled = await b.getByRole('button', { name: /Maccabi/ }).isDisabled()
  console.log('CHECK options disabled after settle:', optionDisabled)
  await shot(b, '16-settled-bettor')

  // 🔍 probe: corrupted key in the share link
  const badLink = link.replace(/.{4}$/, 'aaaa')
  const c = await (await browser.newContext(MOBILE)).newPage()
  await c.goto(badLink)
  await acceptDisclaimer(c)
  const err = await c.locator('.error').first().innerText({ timeout: 15000 })
  console.log('CHECK corrupted-key error:', err)
  await shot(c, '17-bad-key')

  // ---------------- scenario 2: cancel & refund ----------------
  step('scenario 2: pool that gets cancelled')
  await a.goto(BASE + '#/create')
  await a.getByText('Bets will be zapped to').waitFor({ timeout: 15000 })
  await a.getByPlaceholder('Who wins the Champions League final?').fill('Will it rain tomorrow?')
  await optionTitle(a, 0).fill('Yes')
  await optionTitle(a, 1).fill('No')
  await a.getByRole('button', { name: 'Create pool' }).click()
  await a.getByText('Will it rain tomorrow?').waitFor({ timeout: 15000 })
  const link2 = a.url()

  await b.goto(link2)
  await b.getByText('Will it rain tomorrow?').waitFor({ timeout: 15000 })
  await b.getByRole('button', { name: /Yes/ }).click()
  await b.getByText('Bet on “Yes”').waitFor()
  await b.getByPlaceholder(/up to/).fill('1000')
  await b.getByPlaceholder('you@walletofsatoshi.com').fill('winner@localhost:7778')
  await b.getByRole('button', { name: /Get invoice/ }).click()
  await b.getByText('Your bet is in!').waitFor({ timeout: 20000 })
  await b.getByRole('button', { name: 'Done' }).click()

  await a.goto(link2)
  await a.getByText('Pot: 1,000 sats').waitFor({ timeout: 15000 })
  // 🔍 probe: the no-bets option must not be selectable as winner
  const noBetsOption = a.locator('select option', { hasText: 'no bets' })
  console.log('CHECK no-bets option label:', await noBetsOption.innerText())
  console.log('CHECK no-bets option disabled:', await noBetsOption.isDisabled())

  await a.getByRole('button', { name: 'Cancel pool & refund' }).click()
  step('pool cancelled')
  await a.getByText('Refunds — pool cancelled').waitFor({ timeout: 10000 })
  const refundAmt = await a.locator('.payout-row .amt').first().innerText()
  console.log('CHECK refund amount (expect 980):', refundAmt)
  await shot(a, '18-cancelled-refunds')
  await a.getByRole('button', { name: 'Pay', exact: true }).click()
  await a.locator('.qr-wrap img').waitFor({ timeout: 15000 })
  step('refund invoice fetched from bettor wallet')
  await a.getByRole('button', { name: 'Mark paid & close' }).click()
  await a.locator('.payout-row.paid').waitFor({ timeout: 10000 })

  await b.getByText('This pool was cancelled — bets are refunded').waitFor({ timeout: 10000 })
  console.log('CHECK options disabled after cancel:', await b.getByRole('button', { name: /Yes/ }).isDisabled())
  await shot(b, '19-cancelled-bettor')

  console.log('ALL STEPS COMPLETE')
} finally {
  await browser.close()
}
