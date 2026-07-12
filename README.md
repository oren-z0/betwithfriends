# BetWithFriends ⚡

Friendly betting pools with your friends, settled over **bitcoin lightning** —
no server, no signup. Everything lives encrypted on **nostr** relays.

## How it works

1. **An admin creates a pool** — a question with 2+ options (title, optional
   description/image/background, admin fee, max bets, max bet size, optional
   deadline). The pool is published as a nostr event whose content is
   **AES-256-GCM encrypted**.
2. **The share link carries everything**: a NIP-19 `nevent` (event id + relay
   hints) and the AES key, in the URL **hash** — so it never reaches any
   server, and relays only ever see ciphertext.
3. **Friends bet by zapping** (NIP-57): picking an option builds a zap request
   whose content is the encrypted `{ optionId, rewardAddress }` — the reward
   address is additionally NIP-44-encrypted so **only the admin** can read it.
   The bet amount is the zap amount, paid straight to the admin's lightning
   wallet.
4. **The admin settles**: closes betting, declares the winning option, and pays
   each winner `stake / Σ(winning stakes) × pot × (1 − fee)` via lightning
   invoices fetched from the winners' reward addresses. Alternatively the admin
   can **cancel** the pool: no option wins and every bet is refunded minus the
   admin fee. Options nobody bet on can't be declared the winner.

Trust model: the pool is held together by trust in the admin — they receive all
bets and pay winners by hand. **Only bet with someone you know.**

## Nostr events

| Kind | Meaning | Content (AES-256-GCM under the pool key) |
|---|---|---|
| 8880 | Pool | title, options, fee, limits, deadline… |
| 9734/9735 | Bet (NIP-57 zap request/receipt) | `{ optionId, rewardAddress }` |
| 8881 | Admin action | `close` / `winner` / `cancel` / `paid` / `unpaid` |
| 8882 | Comment (admin only) | `{ text }` |

Every event this app authors (8880, 8881, 8882, and the 9734 zap request) also
carries a plaintext `["bwf-version", "1"]` tag, so a future app version can
tell old- vs new-schema events apart before decrypting them.

## Development

```bash
npm install
npm run dev        # public relays
npm test           # unit tests (crypto, payouts, event parsing)
npm run build      # typecheck + production build → dist/
```

Full offline E2E (local relay + mock LNURL wallet + Playwright):

```bash
node e2e/harness.mjs &
VITE_DEFAULT_RELAYS=ws://localhost:7777 npx vite --port 5199 --strictPort &
node e2e/drive.mjs e2e/shots
```

Deploy: static build, works on Netlify/Vercel/Cloudflare (see `netlify.toml`).

## Disclaimer

Bet only with people you personally trust. Gambling may be restricted or
illegal where you live — you are solely responsible for complying with your
local laws.
