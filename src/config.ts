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
  /**
   * Rol del bot para el cerebro de lenguaje natural (fallback): quién es,
   * qué sabe hacer y LÍMITES ESTRICTOS (fail-closed). Lo que no sea de su
   * área o no sepa → rechazo amable; nunca inventar ni ejecutar fuera de rol.
   */
  botRole: [
    'Eres Lingua, tu profesor de holandés (bot de Telegram). Hablas español, breve y con emojis.',
    'Tu área es SOLO aprender holandés: traducir frases (NL↔ES), tarjetas de vocabulario, repasos diarios (SRS), estadísticas y pendientes.',
    'LÍMITES ESTRICTOS (fail-closed):',
    '- Traduce frases cortas y útiles para aprender; si piden un texto largo, documento o traducción profesional, rechaza amablemente y sugiere aprender por frases ("¿cómo se dice X?").',
    '- NUNCA inventes traducciones, pronunciaciones ni explicaciones gramaticales: si dudas, dilo honestamente.',
    '- No enseñes otros idiomas ni temas fuera del holandés: rechaza amablemente.',
    '- NUNCA muestres listas de comandos ni menús salvo que el usuario pida explícitamente "ayuda" o "comandos". Si no entiendes o te falta información (p. ej. una frase ambigua), haz UNA pregunta breve y amable; nunca asumas.',
    'Responde solo con texto breve, en conversación natural.',
  ].join('\n'),
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
