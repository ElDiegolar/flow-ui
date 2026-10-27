/**
 * Pasted-image intake: stores the bytes and returns a path to type.
 */
import type { FastifyInstance } from 'fastify'
import { savePastedImage } from '../paste.ts'

export function registerPasteRoutes(scope: FastifyInstance) {
  // Store a pasted image (base64) and return its path for the terminal to type.
  scope.post<{ Body: { data?: string; type?: string } }>('/api/paste', async (req, reply) => {
    const { data, type } = req.body
    if (!data) {
      reply.code(400)
      return { error: 'data (base64) required' }
    }
    const file = savePastedImage(data, type ?? 'image/png')
    return { path: file }
  })
}
