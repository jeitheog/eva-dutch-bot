/**
 * Tests del flujo de repaso estilo Anki en el poller (callbacks
 * ver-traduccion / explicacion / gradeN, respuestas libres, allowlist) —
 * node:test, cliente y deps falsos, sin red.
 */

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleUpdate, shouldProcess } from '../services/poller'
import { sessions, setSession } from '../services/session'
import { setUserLanguage, setLanguageStoreFileForTests, getUserLanguage } from '../services/user-language'
import type { CardDto } from '../services/dutch'
import type { TelegramClient, TelegramUpdate } from '../services/telegram'
import type { IntentDeps } from '../services/intents'

const JEI = 7026212206
const JESSI = 7181079278
const INTRUSO = 123456789

function makeCard(id: number, front: string, back: string, language = 'nl'): CardDto {
  return {
    id, type: 'phrase', language, front, back, nl: language === 'en' ? '' : front, es: back,
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
    sendVoice: async (_chatId, _voice, caption) => {
      calls.push({ method: 'sendVoice', args: [_chatId, _voice, caption] })
      return { message_id: 200 + calls.length }
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
    getCards: async () => [],
    postReview: async (cardId, grade, latencyMs) => {
      reviews.push({ card_id: cardId, grade, latency_ms: latencyMs })
      onReview?.(cardId, grade)
      return { ok: true, card: queue.find((c) => c.id === cardId) ?? queue[0] }
    },
    getStats: async () => ({ total: 0, nuevas: 0, aprendiendo: 0, dominadas: 0, dificiles: 0, pendientes_hoy: 0, racha: 0, aciertos_pct: 0, por_categoria: {} }),
    getDueStatus: async () => ({ pendientes_hoy: 0, nuevas_disponibles: 20, dificiles: 0 }),
    getStudent: async () => ({ id: 1, nombre: '', nivel: 'beginner', profesion: '', hobbies: '[]', objetivos: '', situaciones: '[]', dificultades: '[]', preferencia_metodo: '', updated_at: 0 }),
    updateStudent: async () => ({ id: 1, nombre: '', nivel: 'beginner', profesion: '', hobbies: '[]', objetivos: '', situaciones: '[]', dificultades: '[]', preferencia_metodo: '', updated_at: 0 }),
    getAudio: async () => new Uint8Array([1, 2, 3]),
    sendMessage: async () => ({}),
    setLanguage: () => {},
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

beforeEach(() => {
  sessions.clear()
  // Aislamiento del idioma activo: cada test usa su propio archivo temporal.
  setLanguageStoreFileForTests(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lingua-lang-test-')), 'user_language.json'))
})

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

  // 1) "repaso" → front UNA sola vez (mensaje con botón) + nota de voz SIN caption
  await handleUpdate(client, messageUpdate(JEI, JEI, 'repaso'), () => deps)
  const voice = calls.find((c) => c.method === 'sendVoice')
  assert.ok(voice, 'envió la nota de voz de pronunciación')
  assert.equal(voice!.args[2], undefined, 'la voz va SIN caption: el front NO se duplica')
  const frontOccurrences = calls.filter((c) => {
    const text = typeof c.args[1] === 'string' ? c.args[1] : ''
    const caption = typeof c.args[2] === 'string' ? c.args[2] : ''
    return text.includes('Geef me de halter even') || caption.includes('Geef me de halter even')
  })
  assert.equal(frontOccurrences.length, 1, 'el front aparece UNA sola vez en todo el flujo')
  const first = calls.find((c) => c.method === 'sendMessage')
  assert.ok(first, 'envió el front')
  assert.ok(calls.indexOf(voice!) > calls.indexOf(first!), 'la voz va DESPUÉS del mensaje con botones (no bloquea la tarjeta)')
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

  // 4) grade3 → POST /review; cola agotada → la sesión NO termina (solo "para")
  await handleUpdate(client, callbackUpdate(JEI, JEI, 'grade3'), () => deps)
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].card_id, 1)
  assert.equal(reviews[0].grade, 3)
  const exhausted = calls.filter((c) => c.method === 'sendMessage').pop()!
  assert.ok((exhausted.args[1] as string).includes('No encuentro más tarjetas'), 'avisa de que no hay material disponible')
  assert.equal(sessions.size, 1, 'la sesión NO se cierra por falta de material: solo "para" la termina')
  // 5) "para" → resumen y sesión cerrada
  await handleUpdate(client, messageUpdate(JEI, JEI, 'para'), () => deps)
  const summary = calls.find((c) => c.method === 'sendMessage' && (c.args[1] as string).includes('Sesión completada'))
  assert.ok(summary, 'resumen enviado al parar')
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
  setSession(JEI, { mode: 'review', queue: [card], idx: 0, correct: 0, wrong: 0, cardShownAt: 0, revealed: true, messageId: 42, seen: [] })
  await handleUpdate(client, callbackUpdate(JEI, INTRUSO, 'grade5'), () => deps)
  assert.equal(calls.length, 0, 'nada se envió')
})

test('"sigue" salta la tarjeta sin calificar; si NO queda nada la sesión sigue viva (solo "para" la cierra)', async () => {
  const card1 = makeCard(1, 'Hallo', 'Hola')
  const card2 = makeCard(2, 'Dank je', 'Gracias')
  const { client, calls } = makeFakeClient()
  // El mock SIEMPRE devuelve [card1, card2] (siguen vencidas) y no hay nada
  // más: ni nuevas, ni difíciles, ni aleatorias, ni generación (translate sin card).
  const { deps, reviews } = makeFakeDeps([card1, card2])

  await handleUpdate(client, messageUpdate(JEI, JEI, 'repaso'), () => deps)
  assert.equal(reviews.length, 0)

  // "sigue" → salta card1 SIN calificar → muestra card2
  await handleUpdate(client, messageUpdate(JEI, JEI, 'sigue'), () => deps)
  const sends = calls.filter((c) => c.method === 'sendMessage')
  assert.equal((sends[sends.length - 1].args[1] as string), '🎴 Dank je')
  assert.equal(reviews.length, 0, 'saltar no califica')

  // "siguiente frase" → salta card2 → todo agotado → la sesión NO se cierra
  await handleUpdate(client, messageUpdate(JEI, JEI, 'siguiente frase'), () => deps)
  const last = calls.filter((c) => c.method === 'sendMessage').pop()!
  assert.ok((last.args[1] as string).includes('reintentar'), 'sugiere reintentar con "sigue" o terminar con "para"')
  assert.equal(sessions.size, 1, 'la sesión sigue viva: el repaso no termina por falta de material')
})

test('"sigue" con recarga real: la cola nueva se muestra (más de N tarjetas)', async () => {
  const card1 = makeCard(1, 'Hallo', 'Hola')
  const card2 = makeCard(2, 'Dank je', 'Gracias')
  const card3 = makeCard(3, 'Tot ziens', 'Hasta luego')
  const { client, calls } = makeFakeClient()
  // Primera llamada devuelve [card1, card2]; la recarga devuelve [card3] (nueva).
  let callsN = 0
  const queue = [
    [card1, card2],
    [card3],
  ]
  const deps: IntentDeps = {
    ...makeFakeDeps([]).deps,
    getReviewQueue: async () => queue[Math.min(callsN++, queue.length - 1)],
  }
  await handleUpdate(client, messageUpdate(JEI, JEI, 'repaso'), () => deps)
  await handleUpdate(client, messageUpdate(JEI, JEI, 'sigue'), () => deps) // salta card1 → card2
  await handleUpdate(client, messageUpdate(JEI, JEI, 'otra'), () => deps) // salta card2 → cola agotada → recarga → card3
  const sends = calls.filter((c) => c.method === 'sendMessage')
  assert.equal((sends[sends.length - 1].args[1] as string), '🎴 Tot ziens')
  assert.equal(sessions.size, 1, 'la sesión sigue viva tras la recarga')
})

test('repaso infinito: cola de vencidas vacía → continúa con tarjetas nuevas (la sesión no para)', async () => {
  const card1 = makeCard(1, 'Hallo', 'Hola')
  const card2 = makeCard(2, 'Dank je', 'Gracias')
  const card3 = makeCard(3, 'Tot ziens', 'Hasta luego')
  const { client, calls } = makeFakeClient()
  // La cola vencida solo trae card1; después solo quedan tarjetas nuevas.
  const deps: IntentDeps = {
    ...makeFakeDeps([]).deps,
    getReviewQueue: async () => [card1],
    getCards: async (status?: string) => (status === 'new' ? [card2, card3] : []),
  }
  await handleUpdate(client, messageUpdate(JEI, JEI, 'repaso'), () => deps)
  // Calificar card1 → cola agotada → recarga: vencidas vacía → nuevas [card2]
  await handleUpdate(client, callbackUpdate(JEI, JEI, 'grade5'), () => deps)
  const sends = calls.filter((c) => c.method === 'sendMessage')
  assert.equal((sends[sends.length - 1].args[1] as string), '🎴 Dank je', 'continúa con una tarjeta nueva')
  assert.equal(sessions.size, 1, 'la sesión NO termina por falta de vencidas')
})

test('repaso infinito: BD sin tarjetas → genera una frase del pool (LLM) y sigue — nunca se queda mudo', async () => {
  const { client, calls } = makeFakeClient()
  const generated = makeCard(99, 'Goedemorgen', 'Buenos días')
  const translateCalls: Array<{ text: string; opts?: { addCard?: boolean } }> = []
  const deps: IntentDeps = {
    ...makeFakeDeps([]).deps,
    getReviewQueue: async () => [],
    getCards: async () => [],
    translate: async (text, opts) => {
      translateCalls.push({ text, opts })
      return { nl: 'Goedemorgen', es: 'Buenos días', pronunciation: '', explanation: '', examples: [], used_llm: true, duplicate: false, card: generated }
    },
  }
  await handleUpdate(client, messageUpdate(JEI, JEI, 'repaso'), () => deps)
  assert.ok(translateCalls.length >= 1, 'se llamó al LLM/pool para generar una frase')
  assert.equal(translateCalls[0].opts?.addCard, true, 'genera la tarjeta con add_card')
  const sends = calls.filter((c) => c.method === 'sendMessage')
  assert.equal((sends[sends.length - 1].args[1] as string), '🎴 Goedemorgen', 'muestra la frase generada del pool')
  assert.equal(sessions.size, 1, 'la sesión sigue viva con material generado')
})

test('"hola"/"inicio" → presentación breve y amable SIN entrevista ni preguntas', async () => {
  const { client, calls } = makeFakeClient()
  const { deps } = makeFakeDeps([])
  await handleUpdate(client, messageUpdate(JEI, JEI, 'hola'), () => deps)
  const sends = calls.filter((c) => c.method === 'sendMessage')
  assert.equal(sends.length, 1, 'un solo mensaje de saludo')
  const text = sends[0].args[1] as string
  assert.ok(text.includes('Lingua'), 'se presenta')
  assert.ok(!text.includes('¿Cómo te llamas?'), 'sin pregunta de entrevista')
  assert.ok(!text.includes('¿A qué te dedicas?'), 'sin pregunta de entrevista')
  assert.ok(!text.toLowerCase().includes('hobbies'), 'sin pregunta de entrevista')
  assert.equal(sessions.size, 0, 'no se crea ninguna sesión de entrevista')
})

test('"para"/"basta"/"stop"/"termina" terminan la sesión con el resumen', async () => {
  const cards = [makeCard(1, 'Dank je wel', 'Muchas gracias'), makeCard(2, 'Tot ziens', 'Hasta luego')]
  const { client, calls } = makeFakeClient()
  const { deps, reviews } = makeFakeDeps(cards)

  await handleUpdate(client, messageUpdate(JEI, JEI, 'repaso'), () => deps)
  // Respuesta libre correcta a la tarjeta 1 → grade 5 → avanza a la 2
  await handleUpdate(client, messageUpdate(JEI, JEI, 'muchas gracias'), () => deps)
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].grade, 5)

  await handleUpdate(client, messageUpdate(JEI, JEI, 'para'), () => deps)
  const summary = calls.find((c) => c.method === 'sendMessage' && (c.args[1] as string).includes('Sesión completada'))
  assert.ok(summary, 'resumen enviado')
  assert.ok((summary!.args[1] as string).includes('1 bien'))
  assert.equal(reviews.length, 1, 'no se calificó la tarjeta 2')
  assert.equal(sessions.size, 0, 'sesión cerrada')
})

// ── Cambio de idioma activo (end-to-end con el store real) ─────────────────

test('"inglés" cambia el idioma y el repaso posterior usa la cola en inglés (en→es)', async () => {
  // La factory replica buildIntentDeps: captura el idioma del store por chat.
  const seen: string[] = []
  const nlCard = makeCard(1, 'Goedemorgen', 'Buenos días', 'nl')
  const enCard = makeCard(2, 'Good morning', 'Buenos días', 'en')
  const { client, calls } = makeFakeClient()
  const factory = (_c: TelegramClient, chatId?: number) => {
    const language = getUserLanguage(chatId ?? JEI)
    return {
      ...makeFakeDeps([]).deps,
      setLanguage: (id: number | string, lang: 'nl' | 'en') => {
        seen.push(`setLanguage:${id}:${lang}`)
        setUserLanguage(id, lang)
      },
      getReviewQueue: async (limit?: number) => {
        seen.push(`queue:${language}:${limit ?? 'default'}`)
        return language === 'en' ? [enCard] : [nlCard]
      },
    }
  }

  // 1) Default: holandés. "repaso" → cola nl.
  await handleUpdate(client, messageUpdate(JEI, JEI, 'repaso'), factory)
  assert.ok(seen.includes('queue:nl:10'), 'el repaso por defecto va en holandés')
  assert.equal(getUserLanguage(JEI), 'nl', 'default nl (no rompe nada)')
  // Cerramos la sesión de repaso para poder cambiar de idioma.
  await handleUpdate(client, messageUpdate(JEI, JEI, 'para'), factory)
  assert.equal(sessions.size, 0)

  // 2) "inglés" → confirmación + persistido 'en'.
  await handleUpdate(client, messageUpdate(JEI, JEI, 'inglés'), factory)
  assert.ok(seen.includes('setLanguage:7026212206:en'), 'setLanguage con en')
  const conf = calls.filter((c) => c.method === 'sendMessage').pop()!
  assert.ok((conf.args[1] as string).includes('A estudiar inglés'), 'confirmación de cambio a inglés')
  assert.equal(getUserLanguage(JEI), 'en', 'idioma persistido')

  // 3) "repaso" (nueva factory, idioma en) → cola en inglés.
  await handleUpdate(client, messageUpdate(JEI, JEI, 'repaso'), factory)
  assert.ok(seen.includes('queue:en:10'), 'el repaso en inglés usa la cola en')
  const front = calls.filter((c) => c.method === 'sendMessage').pop()!
  assert.equal(front.args[1], '🎴 Good morning', 'muestra la tarjeta en inglés')
  // Cerramos la sesión de inglés antes de volver a cambiar de idioma.
  await handleUpdate(client, messageUpdate(JEI, JEI, 'para'), factory)
  assert.equal(sessions.size, 0)

  // 4) "cambiar a holandés" → vuelve a nl.
  await handleUpdate(client, messageUpdate(JEI, JEI, 'cambiar a holandés'), factory)
  assert.equal(getUserLanguage(JEI), 'nl')
})

test('el idioma es por usuario: Jessi sigue en nl aunque Jei esté en en', async () => {
  setUserLanguage(JEI, 'en')
  assert.equal(getUserLanguage(JEI), 'en')
  assert.equal(getUserLanguage(JESSI), 'nl', 'Jessi no hereda el idioma de Jei')
})
