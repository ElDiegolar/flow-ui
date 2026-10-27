import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { HOME_FILES } from './common/home.ts'
import type { FastifyReply, FastifyRequest } from 'fastify'

let token: string | null = null

const TOKEN_FILE = HOME_FILES.token

export function initToken(): string {
  // Explicit override (used by e2e tests to pin a known token). Not persisted —
  // we don't clobber the user's real token file.
  const override = process.env.FLOW_TOKEN
  if (override) {
    token = override
    return token
  }
  // Persist the token to disk so it survives `tsx watch` daemon reloads —
  // otherwise every code edit rotates the token and the browser tab 401s.
  if (existsSync(TOKEN_FILE)) {
    try {
      const cached = readFileSync(TOKEN_FILE, 'utf8').trim()
      if (cached && /^[a-f0-9]{32,}$/.test(cached)) {
        token = cached
        return token
      }
    } catch {
      // fall through to regenerate
    }
  }
  token = randomBytes(24).toString('hex')
  try {
    mkdirSync(path.dirname(TOKEN_FILE), { recursive: true })
    writeFileSync(TOKEN_FILE, token, { mode: 0o600 })
  } catch {
    // non-fatal — token still works for this process lifetime
  }
  return token
}

export function getToken(): string {
  if (!token) throw new Error('token not initialized')
  return token
}

export function requireToken(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  const provided =
    (req.headers['x-flow-token'] as string | undefined) || (req.query as { token?: string })?.token

  if (provided && provided === getToken()) return done()

  reply.code(401).send({ error: 'invalid or missing token' })
}
