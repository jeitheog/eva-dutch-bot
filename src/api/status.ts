/**
 * API de estado de Lingua Bot: GET /api/v1/dutch-bot/status (auth
 * x-dutch-bot-api-key) y POST /api/v1/dutch-bot/ping {chat_id, text} que
 * envía un mensaje REAL por el token del bot (verificación externa).
 */

import { Router } from 'express'
import { z } from 'zod'
import type { TelegramClient } from '../services/telegram'
import { pollerState } from '../services/poller'
import { reminderState } from '../services/reminder'

const pingSchema = z.object({
  chat_id: z.union([z.number(), z.string()]),
  text: z.string().min(1),
})

export function statusRouter(client: TelegramClient): Router {
  const router = Router()

  router.get('/dutch-bot/status', (_req, res) => {
    res.json({
      ok: true,
      service: 'eva-dutch-bot',
      polling: pollerState.polling,
      messages_processed: pollerState.messages_processed,
      last_update_ts: pollerState.last_update_ts,
      last_error: pollerState.last_error,
      reminder: reminderState,
    })
  })

  router.post('/dutch-bot/ping', async (req, res) => {
    const parsed = pingSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Datos inválidos', issues: parsed.error.issues })
    }
    try {
      const result = await client.sendMessage(parsed.data.chat_id, parsed.data.text)
      res.json({ sent: true, chat_id: parsed.data.chat_id, message_id: result.message_id })
    } catch (e) {
      res.status(502).json({ sent: false, error: (e as Error).message })
    }
  })

  return router
}
