// One-off: capture public/og-image.png (1200x630) from the home page.
import { chromium } from 'playwright'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 })
await page.goto('http://localhost:5199')
await page.evaluate(() => localStorage.setItem('bwf.disclaimerAccepted', '1'))
await page.reload()
await page.waitForSelector('.hero', { state: 'visible' })
await page.waitForTimeout(500)
await page.screenshot({ path: 'public/og-image.png' })
await browser.close()
console.log('saved public/og-image.png')
