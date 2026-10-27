/**
 * The Figma assets folder: where get_design_context saves a frame's images,
 * vectors and videos (Setup → Behaviour → Figma assets).
 *
 * Figma Desktop in write-to-disk mode only writes into folders the developer
 * has allow-listed in Dev Mode → MCP → Allowed directories, and refuses the
 * whole call otherwise. That list is Figma's own security setting, so it is
 * only ever READ here — Setup shows whether the folder is on it and, if not,
 * the exact path to add by hand.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { getSettings } from '../settings.ts'

const exec = promisify(execFile)

// Figma Desktop runs on Windows. When the daemon runs under WSL, paths handed
// to it and its settings file have to be translated across the boundary.
const isWsl = () => Boolean(process.env.WSL_DISTRO_NAME)

/** A local path as Figma Desktop (Windows) sees it. Identity off WSL. */
export async function toWindowsPath(p: string): Promise<string> {
  if (!isWsl()) return p
  const { stdout } = await exec('wslpath', ['-w', p], { timeout: 3000 })
  return stdout.trim()
}

/** The Windows user's home, as a WSL path. Null when it cannot be read. */
async function windowsHome(): Promise<string | null> {
  try {
    const { stdout } = await exec('cmd.exe', ['/c', 'echo %USERPROFILE%'], { timeout: 3000 })
    const win = stdout.trim()
    if (!win || win.includes('%')) return null
    const { stdout: unix } = await exec('wslpath', ['-u', win], { timeout: 3000 })
    return unix.trim() || null
  } catch {
    return null
  }
}

export type FigmaAssetsStatus = {
  /** The folder on this machine; null when asset writes are turned off. */
  dir: string | null
  /** The same folder as Figma Desktop sees it — the path to allow-list. */
  figmaPath: string | null
  exists: boolean
  /** On Figma's allowed-directories list; null when that can't be read. */
  allowed: boolean | null
  /** Figma Desktop's settings file the answer came from. */
  settingsFile: string | null
}

async function figmaSettingsFile(): Promise<string | null> {
  let file: string | null = null
  if (isWsl()) {
    const home = await windowsHome()
    if (home) file = path.join(home, 'AppData', 'Roaming', 'Figma', 'settings.json')
  } else if (process.platform === 'win32' && process.env.APPDATA) {
    file = path.join(process.env.APPDATA, 'Figma', 'settings.json')
  } else if (process.platform === 'darwin') {
    file = path.join(os.homedir(), 'Library', 'Application Support', 'Figma', 'settings.json')
  }
  return file && existsSync(file) ? file : null
}

/** Every allow-listed folder, across the Figma accounts signed in on this machine. */
function allowedDirs(file: string): string[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as {
    mcpAllowedDirectoriesByUser?: Record<string, unknown>
  }
  return Object.values(raw.mcpAllowedDirectoriesByUser ?? {})
    .flatMap((v) => (Array.isArray(v) ? v : []))
    .filter((d): d is string => typeof d === 'string')
}

// Windows paths compare case-insensitively and either slash works.
const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
const within = (dir: string, allowed: string) => {
  const d = norm(dir)
  const a = norm(allowed)
  return d === a || d.startsWith(`${a}\\`)
}

/** Status for Setup. `ensure` creates the folder (Connect does this). */
export async function figmaAssetsStatus(ensure = false): Promise<FigmaAssetsStatus> {
  const dir = getSettings().figma.assetsDir || null
  if (!dir) return { dir: null, figmaPath: null, exists: false, allowed: null, settingsFile: null }
  if (ensure) mkdirSync(dir, { recursive: true })
  const figmaPath = await toWindowsPath(dir).catch(() => dir)
  const settingsFile = await figmaSettingsFile()
  let allowed: boolean | null = null
  if (settingsFile) {
    try {
      allowed = allowedDirs(settingsFile).some((a) => within(figmaPath, a))
    } catch {
      /* unreadable mid-write — unknown */
    }
  }
  return { dir, figmaPath, exists: existsSync(dir), allowed, settingsFile }
}
