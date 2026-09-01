/**
 * Tests de intents y lógica de Lingua Bot — node:test, mocks, sin red.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateAnswer,
  formatCardCreated,
  formatLanguageSwitch,
  formatPending,
  formatStats,
  handleSimpleIntent,
  parseIntent,
  reviewKeyboard,
  redactOrFallback,
  buildTranslateContext,
  buildStatsContext,
  buildPendingContext,
  CONTINUE_RE,
  STOP_RE,
  INTRO_TEXT,
  CLARIFICATION_TEXT,
  PHRASE_POOL,
  EN_PHRASE_POOL,
  type Brain,
  type IntentDeps,
} from '../services/intents'
import type { CardDto, DueStatusResponse, StatsResponse, TranslateResponse } from '../services/dutch'

test('parseIntent: "aprender esta frase: X" → translate con X', () => {
  const i = parseIntent('aprender esta frase: Geef me de halter even')
  assert.deepEqual(i, { type: 'translate', text: 'Geef me de halter even' })
})

test('parseIntent: "guarda esta palabra: X" → translate', () => {
  const i = parseIntent('guarda esta palabra: mancuerna')
  assert.deepEqual(i, { type: 'translate', text: 'mancuerna' })
})

test('parseIntent: "¿cómo se dice X?" → translate', () => {
  const i = parseIntent('¿cómo se dice mancuerna?')
  assert.equal(i.type, 'translate')
  assert.equal((i as { text: string }).text, 'mancuerna')
})

test('parseIntent: "quiero aprender a decir X" → translate', () => {
  const i = parseIntent('quiero aprender a decir dank je wel')
  assert.equal(i.type, 'translate')
  assert.equal((i as { text: string }).text, 'dank je wel')
})

test('parseIntent: "repaso" / "repasamos 5 minutos" / "dame 10 frases" → review', () => {
  assert.equal(parseIntent('repaso').type, 'review')
  assert.equal(parseIntent('repasamos 5 minutos').type, 'review')
  assert.equal(parseIntent('dame 10 frases').type, 'review')
  assert.equal(parseIntent('vamos a practicar').type, 'review')
  assert.equal(parseIntent('solo palabras difíciles').type, 'review')
  assert.equal(parseIntent('examen rápido').type, 'review')
})

test('parseIntent: "sigue"/"siguiente"/"otra" (sin sesión activa) → review', () => {
  assert.equal(parseIntent('sigue').type, 'review')
  assert.equal(parseIntent('siguiente').type, 'review')
  assert.equal(parseIntent('siguiente frase').type, 'review')
  assert.equal(parseIntent('otra').type, 'review')
})

test('comandos de control del repaso: CONTINUE_RE / STOP_RE', () => {
  assert.ok(CONTINUE_RE.test('sigue'))
  assert.ok(CONTINUE_RE.test('siguiente'))
  assert.ok(CONTINUE_RE.test('siguiente frase'))
  assert.ok(CONTINUE_RE.test('otra'))
  assert.ok(!CONTINUE_RE.test('siguientes pasos'), 'plural no es comando')
  assert.ok(STOP_RE.test('para'))
  assert.ok(STOP_RE.test('basta'))
  assert.ok(STOP_RE.test('stop'))
  assert.ok(STOP_RE.test('termina'))
  assert.ok(!STOP_RE.test('paraguas'), '"para" exige límite de palabra')
  assert.ok(!STOP_RE.test('terminado'), '"termina" no debe casar "terminado"')
})

test('INTRO_TEXT: presentación breve y amable SIN entrevista ni preguntas', () => {
  assert.ok(INTRO_TEXT.includes('Lingua'))
  assert.ok(INTRO_TEXT.includes('repaso'))
  assert.ok(!INTRO_TEXT.includes('¿Cómo te llamas?'), 'sin pregunta de entrevista')
  assert.ok(!INTRO_TEXT.includes('¿A qué te dedicas?'), 'sin pregunta de entrevista')
  assert.ok(!INTRO_TEXT.toLowerCase().includes('entrevista'), 'no menciona la entrevista')
})

test('PHRASE_POOL: frases básicas en neerlandés para el repaso infinito', () => {
  assert.ok(PHRASE_POOL.length >= 10, 'el pool tiene frases de sobra')
  assert.ok(PHRASE_POOL.every((p) => p.trim().length > 0))
  assert.ok(PHRASE_POOL.includes('dank je wel'))
})

test('EN_PHRASE_POOL: frases básicas en inglés para el repaso infinito en inglés', () => {
  assert.ok(EN_PHRASE_POOL.length >= 10, 'el pool de inglés tiene frases de sobra')
  assert.ok(EN_PHRASE_POOL.every((p) => p.trim().length > 0))
  assert.ok(EN_PHRASE_POOL.includes('good morning'))
})

// ── Cambio de idioma activo (inglés/holandés) ──────────────────────────────

test('parseIntent: "inglés" / "estudiar inglés" / "cambiar a inglés" → language en', () => {
  assert.deepEqual(parseIntent('inglés'), { type: 'language', language: 'en' })
  assert.deepEqual(parseIntent('estudiar inglés'), { type: 'language', language: 'en' })
  assert.deepEqual(parseIntent('cambiar a inglés'), { type: 'language', language: 'en' })
  assert.deepEqual(parseIntent('quiero estudiar inglés'), { type: 'language', language: 'en' })
  assert.deepEqual(parseIntent('vamos a practicar inglés'), { type: 'language', language: 'en' })
  assert.deepEqual(parseIntent('aprender inglés'), { type: 'language', language: 'en' })
})

test('parseIntent: "holandés" / "cambiar a holandés" → language nl', () => {
  assert.deepEqual(parseIntent('holandés'), { type: 'language', language: 'nl' })
  assert.deepEqual(parseIntent('cambiar a holandés'), { type: 'language', language: 'nl' })
  assert.deepEqual(parseIntent('estudiar holandés'), { type: 'language', language: 'nl' })
})

test('parseIntent: el idioma no roba intents de traducción ni de repaso', () => {
  // "¿cómo se dice inglés?" sigue traduciendo la palabra.
  const t = parseIntent('¿cómo se dice inglés?')
  assert.equal(t.type, 'translate')
  assert.equal((t as { text: string }).text, 'inglés')
  // "aprender esta frase: X" sigue traduciendo X.
  assert.deepEqual(parseIntent('aprender esta frase: good morning'), { type: 'translate', text: 'good morning' })
  assert.equal(parseIntent('repaso').type, 'review')
  assert.equal(parseIntent('vamos a practicar').type, 'review')
  assert.equal(parseIntent('cuéntame algo').type, 'chat')
})

test('formatLanguageSwitch: confirmaciones de idioma', () => {
  assert.ok(formatLanguageSwitch('en').includes('A estudiar inglés'))
  assert.ok(formatLanguageSwitch('en').includes('🇬🇧'))
  assert.ok(formatLanguageSwitch('nl').includes('A estudiar holandés'))
  assert.ok(formatLanguageSwitch('nl').includes('🇳🇱'))
})

test('parseIntent: "estadísticas" / "estadisticas" → stats', () => {
  assert.equal(parseIntent('estadísticas').type, 'stats')
  assert.equal(parseIntent('estadisticas').type, 'stats')
  assert.equal(parseIntent('progreso').type, 'stats')
})

test('parseIntent: "pendientes" → pending', () => {
  assert.equal(parseIntent('pendientes').type, 'pending')
  assert.equal(parseIntent('¿cuántas frases me quedan?').type, 'pending')
})

test('parseIntent: "hola" → start, "ayuda"/"comandos" → help, basura → chat (cerebro NL)', () => {
  assert.equal(parseIntent('hola').type, 'start')
  assert.equal(parseIntent('inicio').type, 'start')
  assert.equal(parseIntent('ayuda').type, 'help')
  assert.equal(parseIntent('comandos').type, 'help')
  assert.equal(parseIntent('fjdkalñ').type, 'chat')
  assert.equal(parseIntent('cuéntame algo').type, 'chat')
  assert.equal(parseIntent('').type, 'chat')
})

test('CLARIFICATION_TEXT: pregunta breve y amable, nunca lista comandos', () => {
  assert.ok(CLARIFICATION_TEXT.includes('¿Me lo dices de otra forma?'))
  assert.ok(!CLARIFICATION_TEXT.includes('Comandos'))
  assert.ok(!CLARIFICATION_TEXT.includes('•'))
})

test('evaluateAnswer: coincidencia de palabras clave sin inventar', () => {
  assert.equal(evaluateAnswer('Dame la mancuerna un momento', 'Dame la mancuerna un momento').grade, 5)
  assert.equal(evaluateAnswer('dame la mancuerna', 'Dame la mancuerna un momento').grade, 5) // 3/4 palabras
  const partial = evaluateAnswer('un momento', 'Dame la mancuerna un momento')
  assert.equal(partial.grade, 3) // 2/4 palabras significativas ≥30%
  const fail = evaluateAnswer('no sé qué es', 'Dame la mancuerna un momento')
  assert.equal(fail.grade, 1)
  assert.equal(fail.matched, false)
})

test('formatCardCreated: tarjeta creada vs duplicado', () => {
  const created: TranslateResponse = {
    nl: 'Hallo',
    es: 'Hola',
    pronunciation: 'já-lo',
    explanation: 'Saludo informal.',
    examples: ['Hallo!'],
    used_llm: true,
    duplicate: false,
    card: {
      id: 1, type: 'phrase', language: 'nl', front: 'Hallo', back: 'Hola', nl: 'Hallo', es: 'Hola',
      pronunciation: 'já-lo', explanation: 'Saludo informal.', grammar: '', examples: '[]',
      context: '', category: 'general', source: 'manual', created_at: 0, due_at: 0,
      interval_days: 0, ease: 2.5, repetitions: 0, lapses: 0, status: 'new',
    },
  }
  const msg = formatCardCreated(created)
  assert.ok(msg.includes('Perfecto'))
  assert.ok(msg.includes('Hallo'))
  assert.ok(msg.includes('já-lo'))

  const dup = formatCardCreated({ ...created, duplicate: true, existing_id: 1 })
  assert.equal(dup, 'Ya la tienes 😊')
})

test('formatPending / formatStats / reviewKeyboard', () => {
  const due: DueStatusResponse = { pendientes_hoy: 7, nuevas_disponibles: 20, dificiles: 2 }
  assert.ok(formatPending(due).includes('Tienes 7 frases pendientes'))
  assert.ok(formatPending({ ...due, pendientes_hoy: 0 }).includes('No tienes frases pendientes'))
  const stats: StatsResponse = {
    total: 30, nuevas: 10, aprendiendo: 5, dominadas: 15, dificiles: 2,
    pendientes_hoy: 7, racha: 3, aciertos_pct: 80, por_categoria: { general: 30 },
  }
  assert.ok(formatStats(stats).includes('80%'))
  const kb = reviewKeyboard()
  assert.equal(kb.inline_keyboard.flat().length, 5)
  const grades = kb.inline_keyboard.flat().map((b) => b.callback_data)
  assert.deepEqual(grades, ['grade0', 'grade1', 'grade3', 'grade4', 'grade5'])
})

test('handleSimpleIntent: translate con deps mock → formato de tarjeta', async () => {
  const deps: IntentDeps = {
    translate: async () => ({
      nl: 'Dank je wel', es: 'Muchas gracias', pronunciation: '', explanation: '',
      examples: [], used_llm: true, duplicate: false,
      card: {
        id: 2, type: 'phrase', language: 'nl', front: 'Dank je wel', back: 'Muchas gracias', nl: 'Dank je wel', es: 'Muchas gracias',
        pronunciation: '', explanation: '', grammar: '', examples: '[]', context: '',
        category: 'general', source: 'manual', created_at: 0, due_at: 0,
        interval_days: 0, ease: 2.5, repetitions: 0, lapses: 0, status: 'new',
      },
    }),
    getReviewQueue: async () => [],
    getCards: async () => [],
    postReview: async () => ({ ok: true, card: {} as CardDto }),
    getStats: async () => ({ total: 1, nuevas: 1, aprendiendo: 0, dominadas: 0, dificiles: 0, pendientes_hoy: 1, racha: 0, aciertos_pct: 0, por_categoria: {} }),
    getDueStatus: async () => ({ pendientes_hoy: 1, nuevas_disponibles: 20, dificiles: 0 }),
    getStudent: async () => ({ id: 1, nombre: '', nivel: 'beginner', profesion: '', hobbies: '[]', objetivos: '', situaciones: '[]', dificultades: '[]', preferencia_metodo: '', updated_at: 0 }),
    updateStudent: async (p) => ({ id: 1, nombre: String(p.nombre ?? ''), nivel: 'beginner', profesion: '', hobbies: '[]', objetivos: '', situaciones: '[]', dificultades: '[]', preferencia_metodo: '', updated_at: 0 }),
    getAudio: async () => new Uint8Array(0),
    sendMessage: async () => ({}),
    setLanguage: () => {},
  }
  const resp = await handleSimpleIntent({ type: 'translate', text: 'dank je wel' }, deps, 7026212206)
  assert.ok(resp.includes('Dank je wel'))
  assert.ok(resp.includes('Perfecto'))
})

test('handleSimpleIntent: fallo del servicio → mensaje de error honesto', async () => {
  const deps: IntentDeps = {
    translate: async () => {
      throw new Error('HTTP 500')
    },
    getReviewQueue: async () => [],
    getCards: async () => [],
    postReview: async () => ({ ok: true, card: {} as CardDto }),
    getStats: async () => ({ total: 0, nuevas: 0, aprendiendo: 0, dominadas: 0, dificiles: 0, pendientes_hoy: 0, racha: 0, aciertos_pct: 0, por_categoria: {} }),
    getDueStatus: async () => ({ pendientes_hoy: 0, nuevas_disponibles: 20, dificiles: 0 }),
    getStudent: async () => ({ id: 1, nombre: '', nivel: 'beginner', profesion: '', hobbies: '[]', objetivos: '', situaciones: '[]', dificultades: '[]', preferencia_metodo: '', updated_at: 0 }),
    updateStudent: async (p) => ({ id: 1, nombre: String(p.nombre ?? ''), nivel: 'beginner', profesion: '', hobbies: '[]', objetivos: '', situaciones: '[]', dificultades: '[]', preferencia_metodo: '', updated_at: 0 }),
    getAudio: async () => new Uint8Array(0),
    sendMessage: async () => ({}),
    setLanguage: () => {},
  }
  const resp = await handleSimpleIntent({ type: 'translate', text: 'x' }, deps, 1)
  assert.ok(resp.startsWith('🚨'))
})

// ── Contextos reales para el cerebro NL ─────────────────────────────────────

const CARD_OK: TranslateResponse = {
  nl: 'Hallo',
  es: 'Hola',
  pronunciation: 'já-lo',
  explanation: 'Saludo informal.',
  examples: ['Hallo!'],
  used_llm: true,
  duplicate: false,
  card: {
    id: 1, type: 'phrase', language: 'nl', front: 'Hallo', back: 'Hola', nl: 'Hallo', es: 'Hola',
    pronunciation: 'já-lo', explanation: 'Saludo informal.', grammar: '', examples: '[]',
    context: '', category: 'general', source: 'manual', created_at: 0, due_at: 0,
    interval_days: 0, ease: 2.5, repetitions: 0, lapses: 0, status: 'new',
  },
}

test('buildTranslateContext: los datos reales de la traducción', () => {
  const ctx = buildTranslateContext(CARD_OK)
  assert.ok(ctx.includes('nl: Hallo'))
  assert.ok(ctx.includes('es: Hola'))
  assert.ok(ctx.includes('pronunciacion: já-lo'))
  assert.ok(ctx.includes('explicacion: Saludo informal.'))
  assert.ok(ctx.includes('Hallo!'))
  assert.ok(ctx.includes('tarjeta nueva'))
  assert.ok(buildTranslateContext({ ...CARD_OK, duplicate: true }).includes('ya existía'))
})

test('buildStatsContext / buildPendingContext: datos reales', () => {
  const stats: StatsResponse = {
    total: 30, nuevas: 10, aprendiendo: 5, dominadas: 15, dificiles: 2,
    pendientes_hoy: 7, racha: 3, aciertos_pct: 80, por_categoria: { general: 30 },
  }
  const ctx = buildStatsContext(stats)
  assert.ok(ctx.includes('total: 30'))
  assert.ok(ctx.includes('pendientes_hoy: 7'))
  assert.ok(ctx.includes('aciertos_pct: 80%'))
  assert.ok(ctx.includes('racha_dias: 3'))

  const due: DueStatusResponse = { pendientes_hoy: 7, nuevas_disponibles: 20, dificiles: 2 }
  const pctx = buildPendingContext(due)
  assert.ok(pctx.includes('pendientes_hoy: 7'))
  assert.ok(pctx.includes('nuevas_disponibles: 20'))
})

// ── redactOrFallback: LLM si puede, plantilla si no (nunca mudo) ───────────

const brainNl: Brain = async (req) => ({ response: `Respuesta natural: ${req.context}`, brain: 'nl' })

test('redactOrFallback: sin brain → plantilla; brain nl → LLM; fallo/402 → plantilla', async () => {
  const req = { kind: 'k', userText: 'estadísticas', context: 'total: 30', fallback: 'FB' }
  assert.equal(await redactOrFallback(undefined, req), 'FB')
  assert.equal(await redactOrFallback(brainNl, req), 'Respuesta natural: total: 30')
  assert.equal(
    await redactOrFallback(async () => ({ response: 'X', brain: 'fallback' as const }), req),
    'FB'
  )
  assert.equal(
    await redactOrFallback(async () => { throw new Error('HTTP 402') }, req),
    'FB',
    'si el LLM falla (402/timeout) → plantilla, nunca mudo'
  )
})

test('handleSimpleIntent con brain: stats/pending/translate los redacta el LLM; fallback → plantilla', async () => {
  const stats: StatsResponse = {
    total: 30, nuevas: 10, aprendiendo: 5, dominadas: 15, dificiles: 2,
    pendientes_hoy: 7, racha: 3, aciertos_pct: 80, por_categoria: { general: 30 },
  }
  const baseDeps = {
    translate: async () => CARD_OK,
    getReviewQueue: async () => [],
    getCards: async () => [],
    postReview: async () => ({ ok: true, card: {} as CardDto }),
    getStats: async () => stats,
    getDueStatus: async () => ({ pendientes_hoy: 7, nuevas_disponibles: 20, dificiles: 2 }),
    getStudent: async () => ({ id: 1, nombre: '', nivel: 'beginner', profesion: '', hobbies: '[]', objetivos: '', situaciones: '[]', dificultades: '[]', preferencia_metodo: '', updated_at: 0 }),
    updateStudent: async () => ({ id: 1, nombre: '', nivel: 'beginner', profesion: '', hobbies: '[]', objetivos: '', situaciones: '[]', dificultades: '[]', preferencia_metodo: '', updated_at: 0 }),
    getAudio: async () => new Uint8Array(0),
    sendMessage: async () => ({}),
    setLanguage: () => {},
  }
  const depsNl: IntentDeps = { ...baseDeps, brain: brainNl }
  const depsFb: IntentDeps = { ...baseDeps, brain: async () => ({ response: 'X', brain: 'fallback' as const }) }

  const statsNl = await handleSimpleIntent({ type: 'stats' }, depsNl, 1, 'estadísticas')
  assert.ok(statsNl.startsWith('Respuesta natural:'), 'el LLM redacta las estadísticas')
  assert.ok(statsNl.includes('total: 30'), 'con los datos reales')
  assert.equal(await handleSimpleIntent({ type: 'stats' }, depsFb, 1), formatStats(stats), 'fallback → plantilla exacta')

  const pendingNl = await handleSimpleIntent({ type: 'pending' }, depsNl, 1, 'pendientes')
  assert.ok(pendingNl.startsWith('Respuesta natural:'))
  assert.ok(pendingNl.includes('pendientes_hoy: 7'))
  assert.equal(
    await handleSimpleIntent({ type: 'pending' }, depsFb, 1),
    formatPending({ pendientes_hoy: 7, nuevas_disponibles: 20, dificiles: 2 })
  )

  const trNl = await handleSimpleIntent({ type: 'translate', text: 'hola' }, depsNl, 1, '¿cómo se dice hola?')
  assert.ok(trNl.startsWith('Respuesta natural:'))
  assert.ok(trNl.includes('nl: Hallo'))
  assert.equal(await handleSimpleIntent({ type: 'translate', text: 'hola' }, depsFb, 1), formatCardCreated(CARD_OK))
})

// ── Cambio de idioma: handleSimpleIntent language ──────────────────────────

test('handleSimpleIntent: language en → setLanguage(chatId, en) + confirmación', async () => {
  let setLangChat: number | string | undefined
  let setLangValue: 'nl' | 'en' | undefined
  const deps: IntentDeps = {
    translate: async () => CARD_OK,
    getReviewQueue: async () => [],
    getCards: async () => [],
    postReview: async () => ({ ok: true, card: {} as CardDto }),
    getStats: async () => ({ total: 0, nuevas: 0, aprendiendo: 0, dominadas: 0, dificiles: 0, pendientes_hoy: 0, racha: 0, aciertos_pct: 0, por_categoria: {} }),
    getDueStatus: async () => ({ pendientes_hoy: 0, nuevas_disponibles: 20, dificiles: 0 }),
    getStudent: async () => ({ id: 1, nombre: '', nivel: 'beginner', profesion: '', hobbies: '[]', objetivos: '', situaciones: '[]', dificultades: '[]', preferencia_metodo: '', updated_at: 0 }),
    updateStudent: async () => ({ id: 1, nombre: '', nivel: 'beginner', profesion: '', hobbies: '[]', objetivos: '', situaciones: '[]', dificultades: '[]', preferencia_metodo: '', updated_at: 0 }),
    getAudio: async () => new Uint8Array(0),
    sendMessage: async () => ({}),
    setLanguage: (chatId, lang) => {
      setLangChat = chatId
      setLangValue = lang
    },
  }
  const resp = await handleSimpleIntent({ type: 'language', language: 'en' }, deps, 7026212206)
  assert.equal(setLangChat, 7026212206)
  assert.equal(setLangValue, 'en')
  assert.ok(resp.includes('A estudiar inglés'))
  assert.ok(resp.includes('repaso'))

  const respNl = await handleSimpleIntent({ type: 'language', language: 'nl' }, deps, 7026212206)
  assert.equal(setLangValue, 'nl')
  assert.ok(respNl.includes('A estudiar holandés'))
})

// ── Tarjeta en inglés: formato y contexto ──────────────────────────────────

const CARD_EN: TranslateResponse = {
  language: 'en',
  nl: '',
  en: 'Good morning',
  es: 'Buenos días',
  pronunciation: 'gud mó-rning',
  explanation: 'Saludo de mañana.',
  examples: ['Good morning, how are you?'],
  used_llm: true,
  duplicate: false,
  card: {
    id: 5, type: 'phrase', language: 'en', front: 'Good morning', back: 'Buenos días', nl: '', es: 'Buenos días',
    pronunciation: 'gud mó-rning', explanation: 'Saludo de mañana.', grammar: '', examples: '[]',
    context: '', category: 'general', source: 'manual', created_at: 0, due_at: 0,
    interval_days: 0, ease: 2.5, repetitions: 0, lapses: 0, status: 'new',
  },
}

test('formatCardCreated con tarjeta en inglés: muestra el front en inglés y la traducción', () => {
  const msg = formatCardCreated(CARD_EN)
  assert.ok(msg.includes('Good morning'), 'front en inglés')
  assert.ok(msg.includes('Buenos días'), 'traducción al español')
  assert.ok(msg.includes('gud mó-rning'), 'pronunciación')
})

test('buildTranslateContext con idioma en: "en: <texto>"', () => {
  const ctx = buildTranslateContext(CARD_EN)
  assert.ok(ctx.includes('en: Good morning'))
  assert.ok(ctx.includes('es: Buenos días'))
  assert.ok(!ctx.includes('nl: '), 'no etiqueta el texto como nl')
})
