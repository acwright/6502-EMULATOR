import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The CLI's own version — the same one the app reports, since the shim
 * (PLAN.md §6.3) always runs the CLI bundled inside the currently-installed
 * app, never a separately-versioned package.
 *
 * `npm_package_version` only exists when launched via an `npm run` script —
 * never true for the installed shim — so this reads `package.json` directly,
 * two directories up from this compiled file both in a repo checkout
 * (`out/cli/version.js` → repo root) and inside the packaged asar
 * (`/out/cli/version.js` → `/package.json`, the archive root).
 */
export function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      version?: string
    }
    return pkg.version ?? 'dev'
  } catch {
    return 'dev'
  }
}
