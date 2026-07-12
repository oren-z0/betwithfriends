// Zips the built dist/ output (after `vite build` has run) and drops the
// archive back into dist/ itself, so it gets deployed and served as just
// another static file — e.g. https://<host>/betwithfriends-dist.zip — letting
// anyone download and self-host the exact static files that are live.
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const distDir = fileURLToPath(new URL('../dist/', import.meta.url))
const zipName = 'betwithfriends-dist.zip'

if (!existsSync(distDir)) {
  console.error('dist/ not found — run `vite build` first')
  process.exit(1)
}

rmSync(`${distDir}${zipName}`, { force: true })
// -X: no extra file attributes (reproducible-ish output); run from inside
// dist/ so paths in the archive are relative (no leading dist/ folder).
execFileSync('zip', ['-rX', zipName, '.'], { cwd: distDir, stdio: 'inherit' })
console.log(`wrote dist/${zipName}`)
