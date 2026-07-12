import { execSync } from 'node:child_process'
import { defineConfig } from 'vitest/config'

function gitVersion(): { date: string; hash: string } {
  try {
    const date = execSync('git log -1 --format=%cd --date=format:%Y-%m-%d').toString().trim()
    const hash = execSync('git rev-parse HEAD').toString().trim().slice(0, 6)
    return { date, hash }
  } catch {
    return { date: '', hash: '' }
  }
}

const { date: GIT_DATE, hash: GIT_HASH } = gitVersion()

export default defineConfig({
  define: {
    __GIT_DATE__: JSON.stringify(GIT_DATE),
    __GIT_HASH__: JSON.stringify(GIT_HASH),
  },
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
  },
})
