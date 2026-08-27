import 'dotenv/config'
import path from 'node:path'

/** Raíz del repo: dist/config.js → un nivel arriba. */
export const APP_DIR = path.resolve(__dirname, '..')

export const config = {
  port: Number(process.env.DUTCH_BOT_PORT ?? 3023),
  apiKey: process.env.DUTCH_BOT_API_KEY ?? '',
  /** Token del bot de Lingua — el bot responde por SU chat. */
  botToken: process.env.DUTCH_BOT_TOKEN ?? '',
  /** eva-dutch-service (3022), el cerebro. */
  serviceBaseUrl: process.env.DUTCH_SERVICE_URL ?? 'http://127.0.0.1:3022',
  serviceApiKey: process.env.DUTCH_SERVICE_API_KEY ?? '',
  /** Estado persistente del poller y recordatorios. */
  dataDir: path.join(APP_DIR, 'data', 'dutch'),
  /** Dueños autorizados: Jei y Jessi. El resto se ignora silenciosamente. */
  authorizedUserIds: [7026212206, 7181079278],
  /** Long-polling de Telegram. */
  pollTimeoutSec: 30,
  /** Recordatorios automáticos: cada 4h. */
  reminderIntervalMs: Number(process.env.DUTCH_REMINDER_INTERVAL_MS ?? 4 * 60 * 60 * 1000),
  /** Chat al que van los recordatorios (Jei). */
  reminderChatId: 7026212206,
}

/** Auth service-to-service: header x-dutch-bot-api-key. */
export function requireApiKey(
  req: { header(name: string): string | undefined },
  res: { status(code: number): { json(body: unknown): unknown } },
  next: () => void
): void {
  const key = req.header('x-dutch-bot-api-key')
  if (!config.apiKey || key !== config.apiKey) {
    res.status(401).json({ error: 'No autorizado' })
    return
  }
  next()
}
