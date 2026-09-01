import express from 'express'
import { config, requireApiKey } from './config'
import { statusRouter } from './api/status'
import { startPoller } from './services/poller'
import { startReminder } from './services/reminder'
import { createTelegramClient } from './services/telegram'
import { createDutchClient } from './services/dutch'
import { getUserLanguage } from './services/user-language'

const app = express()
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => res.json({ ok: true, service: 'eva-dutch-bot' }))

const telegramClient = createTelegramClient({ token: config.botToken })

app.use('/api/v1', requireApiKey)
app.use('/api/v1', statusRouter(telegramClient))

app.listen(config.port, '127.0.0.1', () => {
  console.log(`eva-dutch-bot escuchando en http://127.0.0.1:${config.port}`)
  // El poller y los recordatorios arrancan con el servicio (tras el listen).
  startPoller().catch((e) => console.error(`dutch-poller: ${(e as Error).message}`))
  const dutchClient = createDutchClient()
  startReminder({
    // El recordatorio sigue el idioma activo de Jei (holandés por defecto).
    getDueStatus: () => dutchClient.getDueStatus(getUserLanguage(config.reminderChatId)),
    sendMessage: (chatId, text) => telegramClient.sendMessage(chatId, text),
  })
})
