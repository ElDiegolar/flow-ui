/**
 * Pasted-image store. xterm.js can't paste images, so the web terminal uploads
 * the image here; we write it to a file and return the path, which the UI then
 * types into the terminal. The orchestrator (Claude Code) gets --add-dir to
 * this directory, so it can Read pasted images by path.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { HOME_DIRS } from './common/home.ts'

export const PASTE_DIR = HOME_DIRS.pastes

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
}

/** Save a base64 image and return its absolute path. */
export function savePastedImage(base64: string, mime: string): string {
  const ext = EXT[mime] ?? 'png'
  mkdirSync(PASTE_DIR, { recursive: true })
  const file = path.join(PASTE_DIR, `paste-${randomUUID()}.${ext}`)
  writeFileSync(file, Buffer.from(base64, 'base64'))
  return file
}
