import { bytesToBase64Url } from '../crypto/aes'
import { signEvent, type Session } from './keys'

/**
 * Blossom (BUD-01/02/11) media servers: content-addressed blob storage
 * authenticated with a nostr-signed event — no account/API key needed, which
 * fits this app's no-backend, bring-your-own-identity model. A short,
 * hand-picked list rather than a free-text host, since an arbitrary server
 * could be malicious (see the upload size cap and disclaimer below).
 */
export interface BlossomServer {
  id: string
  label: string
  url: string
}

export const BLOSSOM_SERVERS: BlossomServer[] = [
  // blossom.band is run on nostr.build's infrastructure (its own homepage
  // says so, and uploads redirect to an image.nostr.build URL) — labeled
  // explicitly so admins can judge that operator relationship themselves.
  { id: 'blossom-band', label: 'blossom.band (nostr.build)', url: 'https://blossom.band' },
  { id: 'primal', label: 'Primal', url: 'https://blossom.primal.net' },
  { id: 'nostrcheck', label: 'Nostrcheck.me', url: 'https://nostrcheck.me' },
]

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 10 MB

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Builds and signs the BUD-11 authorization event, then encodes it as the Authorization header value. */
async function buildAuthHeader(
  session: Session,
  action: 'upload',
  hash: string,
  serverUrl: string,
): Promise<string> {
  const signed = await signEvent(session, {
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000),
    content: 'Upload an image for a BetWithFriends pool',
    tags: [
      ['t', action],
      ['x', hash],
      ['expiration', String(Math.floor(Date.now() / 1000) + 300)],
      ['server', new URL(serverUrl).host],
    ],
  })
  return `Nostr ${bytesToBase64Url(new TextEncoder().encode(JSON.stringify(signed)))}`
}

/** Uploads a file to a Blossom server, returning its public URL. */
export async function uploadToBlossom(session: Session, server: BlossomServer, file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Only image files can be uploaded')
  if (file.type === 'image/svg+xml') {
    throw new Error('SVG images can’t be uploaded (they can embed code) — use PNG, JPG, WEBP or GIF, or paste a URL')
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`Image is too large — max ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`)
  }
  const bytes = await file.arrayBuffer()
  const hash = await sha256Hex(bytes)
  const authHeader = await buildAuthHeader(session, 'upload', hash, server.url)
  const res = await fetch(`${server.url}/upload`, {
    method: 'PUT',
    headers: {
      Authorization: authHeader,
      'Content-Type': file.type,
      'X-SHA-256': hash,
    },
    body: bytes,
  })
  if (!res.ok) {
    const reason = res.headers.get('X-Reason')
    throw new Error(`Upload failed (${server.label}): ${reason ?? `HTTP ${res.status}`}`)
  }
  const descriptor = (await res.json()) as { url?: string }
  if (!descriptor.url) throw new Error(`${server.label} did not return an image URL`)
  return descriptor.url
}
