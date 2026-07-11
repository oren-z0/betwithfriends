// E2E harness: in-memory nostr relay (NIP-01) + mock LNURL-pay wallet that
// "pays" every invoice instantly by publishing a kind-9735 zap receipt.
import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

const RELAY_PORT = 7777
const WALLET_PORT = 7778

// ---------------- relay ----------------
const events = []
const subs = new Map() // ws -> Map(subId -> filters)

function matches(filter, ev) {
  if (filter.ids && !filter.ids.includes(ev.id)) return false
  if (filter.kinds && !filter.kinds.includes(ev.kind)) return false
  if (filter.authors && !filter.authors.includes(ev.pubkey)) return false
  for (const [k, vals] of Object.entries(filter)) {
    if (k.startsWith('#')) {
      const tag = k.slice(1)
      if (!ev.tags.some((t) => t[0] === tag && vals.includes(t[1]))) return false
    }
  }
  return true
}

const wss = new WebSocketServer({ port: RELAY_PORT })
wss.on('connection', (ws) => {
  subs.set(ws, new Map())
  ws.on('close', () => subs.delete(ws))
  ws.on('message', (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }
    const [type, ...rest] = msg
    if (type === 'EVENT') {
      const ev = rest[0]
      if (!events.some((e) => e.id === ev.id)) {
        events.push(ev)
        for (const [client, clientSubs] of subs) {
          for (const [subId, filters] of clientSubs) {
            if (filters.some((f) => matches(f, ev)) && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(['EVENT', subId, ev]))
            }
          }
        }
      }
      ws.send(JSON.stringify(['OK', ev.id, true, '']))
    } else if (type === 'REQ') {
      const [subId, ...filters] = rest
      subs.get(ws)?.set(subId, filters)
      for (const ev of events) {
        if (filters.some((f) => matches(f, ev))) ws.send(JSON.stringify(['EVENT', subId, ev]))
      }
      ws.send(JSON.stringify(['EOSE', subId]))
    } else if (type === 'CLOSE') {
      subs.get(ws)?.delete(rest[0])
    }
  })
})
console.log(`relay listening on ws://localhost:${RELAY_PORT}`)

// ---------------- mock LNURL wallet ----------------
const providerSk = generateSecretKey()
const providerPk = getPublicKey(providerSk)

function publishToRelay(event) {
  const ws = new WebSocket(`ws://localhost:${RELAY_PORT}`)
  ws.on('open', () => {
    ws.send(JSON.stringify(['EVENT', event]))
    setTimeout(() => ws.close(), 200)
  })
}

const wallet = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${WALLET_PORT}`)
  res.setHeader('access-control-allow-origin', '*')
  const lnurlpMatch = /^\/\.well-known\/lnurlp\/([a-z0-9]+)$/.exec(url.pathname)
  if (lnurlpMatch) {
    res.end(JSON.stringify({
      tag: 'payRequest',
      callback: `http://localhost:${WALLET_PORT}/callback/${lnurlpMatch[1]}`,
      minSendable: 1000,
      maxSendable: 100_000_000_000,
      metadata: JSON.stringify([['text/plain', `pay ${lnurlpMatch[1]}`]]),
      allowsNostr: true,
      nostrPubkey: providerPk,
    }))
    return
  }
  if (url.pathname.startsWith('/callback/')) {
    const amount = Number(url.searchParams.get('amount'))
    const nostr = url.searchParams.get('nostr')
    // Fake invoice: undecodable by light-bolt11-decoder → app falls back to the amount tag.
    const pr = 'lnbc1mockinvoice' + Math.random().toString(36).slice(2)
    if (nostr) {
      // Simulate instant payment: publish the zap receipt right away.
      const zapRequest = JSON.parse(nostr)
      const pTag = zapRequest.tags.find((t) => t[0] === 'p')
      const eTag = zapRequest.tags.find((t) => t[0] === 'e')
      const receipt = finalizeEvent({
        kind: 9735,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          pTag,
          ...(eTag ? [eTag] : []),
          ['bolt11', pr],
          ['description', nostr],
        ],
        content: '',
      }, providerSk)
      setTimeout(() => publishToRelay(receipt), 1500)
      console.log(`wallet: zap invoice for ${amount} msats → receipt scheduled`)
    } else {
      console.log(`wallet: plain invoice for ${amount} msats`)
    }
    res.end(JSON.stringify({ pr, routes: [] }))
    return
  }
  res.statusCode = 404
  res.end('{}')
})
wallet.listen(WALLET_PORT, () => console.log(`wallet listening on http://localhost:${WALLET_PORT}`))
