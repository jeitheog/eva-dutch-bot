/**
 * Tests del flujo de repaso estilo Anki en el poller (callbacks
 * ver-traduccion / explicacion / gradeN, respuestas libres, allowlist) —
 * node:test, cliente y deps falsos, sin red.
 */

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { handleUpdate, shouldProcess } from '../services/poller'
import { sessions, setSession } from '../services/session'
import type { CardDto } from '../services/dutch'
import type { TelegramClient, TelegramUpdate } from '../services/telegram'
import type { IntentDeps } from '../services/intents'

const JEI = 7026212206
const JESSI = 7181079278
const INTRUSO = 123456789

function makeCard(id: number, front: string, back: string): CardDto {
  return {
    id, type: 'phrase', front, back, nl: front, es: back,
    pronunciation: 'pron', explanation: 'explicación gramatical',
    grammar: '', examples: JSON.stringify(['Ejemplo 1 — Ejemplo 1 ES']),
    context: '', category: 'general', source: 'manual',
    created_at: 0, due_at: 0, interval_days: 0, ease: 2.5,
    repetitions: 0, lapses: 0, status: 'new',
  }
}

interface Call {
  method: string
  args: unknown[]
}

function makeFakeClient(): { client: TelegramClient; calls: Call[] } {
  const calls: Call[] = []
  const client: TelegramClient = {
    getUpdates: async () => [],
    sendMessage: async (_chatId, text, markup) => {
      calls.push({ method: 'sendMessage', args: [_chatId, text, markup] })
      return { message_id: 100 + calls.length }
    },
    editMessageText: async (...args) => {
      calls.push({ method: 'editMessageText', args })
      return { message_id: 0 }
    },
    answerCallbackQuery: async (id) => {
      calls.push({ method: 'answerCallbackQuery', args: [id] })
      return true
    },
  }
  return { client, calls }
}

function makeFakeDeps(queue: CardDto[], onReview?: (cardId: number, grade: number) => void) {
  const reviews: Array<{ card_id: number; grade: number; latency_ms: number }> = []
  const deps: IntentDeps = {
    translate: async () => ({ nl: 'X', es: 'Y', pronunciation: '', explanation: '', examples: [], used_llm: true, duplicate: false }),
    getReviewQueue: async () => queue,
    postReview: async (cardId, grade, latencyMs) => {
      reviews.push({ card_id: cardId, grade, latency_ms: latencyMs })
      onReview?.(cardId, grade)
      return { ok: true, card: queue.find((c) => c.id === cardId) ?? queue[0] }
    },
    getStats: async () => ({ total: 0, nuevas: 0, aprendiendo: 0, dominadas: 0, dificiles: 0, pendientes_hoy: 0, racha: 0, aciertos_pct: 0, por_categoria: {} }),
    getDueStatus: async () => ({ pendientes_hoy: 0, nuevas_disponibles: 20, dificiles: 0 }),
    getStudent: async () => ({ id: 1, nombre: '', nivel: 'beginner', profesion: '', hobbies: '[]', objetivos: '', situaciones: '[]', dificultades: '[]', preferencia_metodo: '', updated_at: 0 }),
    updateStudent: async () => ({ id: 1, nombre: '', nivel: 'beginner', profesion: '', hobbies: '[]', objetivos: '', situaciones: '[]', dificultades: '[]', preferencia_metodo: '', updated_at: 0 }),
    sendMessage: async () => ({}),
  }
  return { deps, reviews }
}

function callbackUpdate(chatId: number, userId: number, data: string): TelegramUpdate {
  return {
    update_id: 1,
    callback_query: {
      id: `cb-${data}`,
      from: { id: userId, first_name: 't' },
      message: { message_id: 42, chat: { id: chatId, type: 'private' }, from: { id: userId }, text: 'x' },
      data,
    },
  }
}

function messageUpdate(chatId: number, userId: number, text: string): TelegramUpdate {
  return {
    update_id: 2,
    message: { message_id: 43, chat: { id: chatId, type: 'private' }, from: { id: userId }, text },
  }
}

beforeEach(() => sessions.clear())

test('allowlist: Jei y Jessi autorizados; cualquier otro → ignore', () => {
  assert.equal(shouldProcess({ type: 'private', id: 1 }, JEI), 'process')
  assert.equal(shouldProcess({ type: 'private', id: 1 }, JESSI), 'process')
  assert.equal(shouldProcess({ type: 'private', id: 1 }, INTRUSO), 'ignore')
  assert.equal(shouldProcess({ type: 'group', id: 1 }, JEI), 'ignore')
})

test('flujo Anki completo: repaso → front solo → ver-traduccion → explicacion → grade3 → resumen', async () => {
  const card = makeCard(1, 'Geef me de halter even', 'Dame la mancuerna un momento')
  const { client, calls } = makeFakeClient()
  const { deps, reviews } = makeFakeDeps([card])

  // 1) "repaso" → solo el front + botón ver-traducción
  await handleUpdate(client, messageUpdate(JEI, JEI, 'repaso'), () => deps)
  const first = calls.find((c) => c.method === 'sendMessage')
  assert.ok(first, 'envió el front')
  const frontText = first!.args[1] as string
  assert.equal(frontText, '🎴 Geef me de halter even')
  assert.ok(!frontText.includes('Dame la mancuerna'), 'front sin traducción')
  const frontMarkup = first!.args[2] as { inline_keyboard: Array<Array<{ callback_data?: string }>> }
  assert.equal(frontMarkup.inline_keyboard[0][0].callback_data, 'ver-traduccion')

  // 2) ver-traduccion → edit con back + teclado de calificación
  await handleUpdate(client, callbackUpdate(JEI, JEI, 'ver-traduccion'), () => deps)
  const reveal = calls.find((c) => c.method === 'editMessageText')
  assert.ok(reveal, 'editó el mensaje')
  const backText = reveal!.args[2] as string
  assert.ok(backText.includes('Dame la mancuerna un momento'))
  const backMarkup = reveal!.args[3] as { inline_keyboard: Array<Array<{ callback_data?: string }>> }
  const data = backMarkup.inline_keyboard.flat().map((b) => b.callback_data)
  assert.deepEqual(data, ['explicacion', 'grade0', 'grade1', 'grade3', 'grade4', 'grade5'])

  // 3) explicacion → edit con la explicación + ejemplos, y teclado de grades
  await handleUpdate(client, callbackUpdate(JEI, JEI, 'explicacion'), () => deps)
  const explain = calls.filter((c) => c.method === 'editMessageText').pop()!
  const explainText = explain.args[2] as string
  assert.ok(explainText.includes('explicación gramatical'))
  assert.ok(explainText.includes('Ejemplo 1'))
  const explainMarkup = explain.args[3] as { inline_keyboard: Array<Array<{ callback_data?: string }>> }
  assert.ok(explainMarkup.inline_keyboard.flat().some((b) => b.callback_data === 'grade5'))

  // 4) grade3 → POST /review y resumen de sesión (cola de 1)
  await handleUpdate(client, callbackUpdate(JEI, JEI, 'grade3'), () => deps)
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].card_id, 1)
  assert.equal(reviews[0].grade, 3)
  const summary = calls.find((c) => c.method === 'sendMessage' && (c.args[1] as string).includes('Sesión completada'))
  assert.ok(summary, 'resumen enviado')
  assert.equal(sessions.size, 0, 'sesión cerrada')
})

test('respuesta libre correcta → grade 5 y siguiente tarjeta', async () => {
  const cards = [
    makeCard(1, 'Dank je wel', 'Muchas gracias'),
    makeCard(2, 'Tot ziens', 'Hasta luego'),
  ]
  const { client, calls } = makeFakeClient()
  const { deps, reviews } = makeFakeDeps(cards)

  await handleUpdate(client, messageUpdate(JEI, JEI, 'repaso'), () => deps)
  // Respuesta libre al front de la tarjeta 1 (aún no revelada)
  await handleUpdate(client, messageUpdate(JEI, JEI, 'muchas gracias'), () => deps)
  assert.equal(reviews[0].grade, 5, 'coincidencia total → domino')
  // Se reveló y avanzó a la tarjeta 2 (front de Tot ziens)
  const lastSend = calls.filter((c) => c.method === 'sendMessage').pop()!
  assert.equal(lastSend.args[1], '🎴 Tot ziens')
})

test('callback de intruso → ignorado silenciosamente (sin answerCallbackQuery)', async () => {
  const card = makeCard(1, 'Hallo', 'Hola')
  const { client, calls } = makeFakeClient()
  const { deps } = makeFakeDeps([card])
  setSession(JEI, { mode: 'review', queue: [card], idx: 0, correct: 0, wrong: 0, cardShownAt: 0, revealed: true, messageId: 42 })
  await handleUpdate(client, callbackUpdate(JEI, INTRUSO, 'grade5'), () => deps)
  assert.equal(calls.length, 0, 'nada se envió')
})
