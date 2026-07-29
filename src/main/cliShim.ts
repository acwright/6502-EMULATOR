import { app } from 'electron'
import { chmod, mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { CliShimStatus } from '../shared/types'

/**
 * Installs the `6502` command described in PLAN.md §6.3.
 *
 * The trick that makes this work with no separate download: Electron already
 * bundles Node, and launching the app's own binary with
 * `ELECTRON_RUN_AS_NODE=1` runs it as a plain Node interpreter. The shim is
 * three lines that `exec` the app binary that way, pointed at the CLI's own
 * entry point inside the packaged app — so the CLI can never drift from the
 * app version, and the user never installs Node.
 *
 * Only meaningful in a packaged build. In development there is no app binary
 * to point the shim at, and `npm run cli` already runs it directly.
 */
export class CliShimService {
  /**
   * Where the shim goes.
   *
   * `/usr/local/bin` needs no PATH change — it's on the default PATH on both
   * macOS and Linux — but is not always writable without elevated privileges.
   * `~/.local/bin` almost always is, at the cost of needing to be on PATH,
   * which is why install() reports which one it used.
   */
  private candidatePaths(): string[] {
    return ['/usr/local/bin/6502', join(homedir(), '.local', 'bin', '6502')]
  }

  /** The packaged app's own binary — what the shim re-launches as Node. */
  private appBinaryPath(): string {
    return process.execPath
  }

  /**
   * The CLI's entry point inside the packaged app.
   *
   * `files: ['out/**\/*']` in electron-builder.yml packs `out/` at the asar
   * root with its path preserved, so `out/cli/index.js` on disk becomes
   * `app.asar/out/cli/index.js` inside the package — confirmed against where
   * `main`'s own entry actually lands, rather than assumed.
   */
  private cliEntryPath(): string {
    return join(process.resourcesPath, 'app.asar', 'out', 'cli', 'index.js')
  }

  private shimScript(): string {
    return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${this.appBinaryPath()}" "${this.cliEntryPath()}" "$@"\n`
  }

  private get platformSupported(): 'unix' | 'unsupported' {
    return process.platform === 'darwin' || process.platform === 'linux' ? 'unix' : 'unsupported'
  }

  async status(): Promise<CliShimStatus> {
    if (process.platform === 'win32') {
      // The NSIS installer adds the install directory to PATH directly —
      // there is no separate shim file for this action to manage.
      return { installed: false, managedByInstaller: true }
    }

    for (const path of this.candidatePaths()) {
      if (!existsSync(path)) continue
      try {
        const content = await readFile(path, 'utf8')
        // Only claim an existing file as "ours" if it points at this app —
        // a stale shim from a previous install location should not be hidden
        // from the user as if everything were already in order.
        if (content.includes(this.appBinaryPath())) return { installed: true, path }
      } catch {
        // Unreadable — not something this service put there.
      }
    }
    return { installed: false }
  }

  async install(): Promise<{ ok: boolean; message: string }> {
    if (!app.isPackaged) {
      return { ok: false, message: 'Only available in a packaged build — use `npm run cli` in development.' }
    }
    if (this.platformSupported === 'unsupported') {
      return { ok: false, message: `${process.platform} is not supported by this action.` }
    }

    const script = this.shimScript()

    for (const path of this.candidatePaths()) {
      try {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, script, { mode: 0o755 })
        await chmod(path, 0o755)

        const onDefaultPath = path.startsWith('/usr/local/bin/')
        return {
          ok: true,
          message: onDefaultPath
            ? `Installed at ${path}. Open a new terminal and run "6502 --version" to check.`
            : `Installed at ${path}. Add "${dirname(path)}" to your shell's PATH if "6502" is not found — ` +
              `for example, add 'export PATH="$HOME/.local/bin:$PATH"' to your shell's profile.`
        }
      } catch {
        // Try the next candidate — most often /usr/local/bin needing sudo.
        continue
      }
    }

    return {
      ok: false,
      message:
        'Could not write to /usr/local/bin or ~/.local/bin. Run `sudo mkdir -p /usr/local/bin && ' +
        'sudo chown $(whoami) /usr/local/bin` once, then try again.'
    }
  }

  async uninstall(): Promise<{ ok: boolean; message: string }> {
    const current = await this.status()
    if (!current.installed || !current.path) {
      return { ok: true, message: 'Nothing to remove.' }
    }
    try {
      await unlink(current.path)
      return { ok: true, message: `Removed ${current.path}.` }
    } catch (e) {
      return { ok: false, message: `Could not remove ${current.path}: ${(e as Error).message}` }
    }
  }
}
