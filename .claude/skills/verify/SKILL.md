---
name: verify
description: Build, launch and drive BetWithFriends end-to-end against a local Nostr relay + mock LNURL wallet, with screenshots.
---

# Verifying BetWithFriends

Frontend-only SPA (Vite + TS + Alpine). State lives on Nostr relays; bets are
NIP-57 zaps. Full E2E runs offline against a local harness — no public relays,
no real sats.

## Recipe

```bash
# 1. Local relay (ws://localhost:7777) + mock LNURL wallet (http://localhost:7778).
#    The wallet "pays" every zap invoice instantly by publishing a kind-9735 receipt.
node e2e/harness.mjs &

# 2. Dev server pointed at the local relay (must be exactly this env var):
VITE_DEFAULT_RELAYS=ws://localhost:7777 npx vite --port 5199 --strictPort &

# 3. Drive the full journey (Playwright + system Chrome, mobile viewport 390x844):
node e2e/drive.mjs e2e/shots
```

`drive.mjs` covers: disclaimer gate → profile creation with nsec-backup gate →
wallet check (missing → save `admin@localhost:7778` → verified) → pool creation →
bettor opens share link → anonymous zap (incl. over-max and bad-address probes) →
invoice → receipt → live pot updates → second bet → admin comment (ADMIN badge) →
declare winner → payout invoice (expected `1,470 sats` for the default script) →
mark paid → bettor sees "settled", options disabled → corrupted-key link probe.
It prints `ALL STEPS COMPLETE` on success and `CHECK …` lines for assertions;
screenshots land in `e2e/shots/`.

## Gotchas

- Lightning addresses on `localhost:<port>` resolve over **http** (see
  `lightningAddressToUrl`) — that's what makes the mock wallet reachable.
- The mock wallet's invoices are not real bolt11; the app falls back to the zap
  request's `amount` tag for the amount (`parseZapReceipt`), which is exactly
  the production fallback path.
- Unit tests: `npx vitest run` (crypto round-trips, payout math, event/zap
  parsing). Build: `npm run build`.
- Real-sats smoke test (optional, manual): run without `VITE_DEFAULT_RELAYS`,
  use a real lightning address (Wallet of Satoshi / Alby / Coinos) and zap ~21
  sats; the admin's LNURL server must have `allowsNostr: true`.
