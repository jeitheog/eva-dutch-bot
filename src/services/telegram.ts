/**
 * Cliente mínimo de la Bot API de Telegram para Lingua (eva-dutch-bot).
 * Todas las llamadas usan el MISMO token del bot de Lingua: lo que entra y
 * lo que sale va por el mismo bot — "sale por donde se manda" (patrón
 * eva-youtube-bot / nova-bridge). Soporta botones inline (repaso SM-2).
 */

export interface TelegramUser {
  id: number
  first_name?: string
  username?: string
}

export interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
}

export interface TelegramMessage {
  message_id: number
  chat: TelegramChat
  from?: TelegramUser
  text?: string
  caption?: string
}

export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  message?: TelegramMessage
  data?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

export interface InlineKeyboardButton {
  text: string
  callback_data?: string
}

export interface TelegramClient {
  getUpdates(offset: number, timeoutSec?: number): Promise<TelegramUpdate[]>
  sendMessage(
    chatId: number | string,
    text: string,
    replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] }
  ): Promise<{ message_id: number }>
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean>
}

interface TgResponse<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

export function createTelegramClient(opts: {
  token: string
  fetchImpl?: typeof fetch
}): TelegramClient {
  const fetchImpl = opts.fetchImpl ?? fetch
  const base = `https://api.telegram.org/bot${opts.token}`

  async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(`${base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    const data = (await res.json()) as TgResponse<T>
    if (!data.ok) {
      const err = new Error(`Telegram ${method}: ${data.description ?? 'error desconocido'}`) as Error & {
        code?: number
      }
      err.code = data.error_code
      throw err
    }
    return data.result as T
  }

  return {
    getUpdates: (offset, timeoutSec = 30) =>
      call<TelegramUpdate[]>('getUpdates', {
        offset,
        timeout: timeoutSec,
        allowed_updates: ['message', 'callback_query'],
      }),
    sendMessage: (chatId, text, replyMarkup) =>
      call<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    answerCallbackQuery: (callbackQueryId, text) =>
      call<boolean>('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) }),
  }
}
