/**
 * Poller de Telegram de Lingua: long-polling con el token del bot de Lingua.
 * Solo Jei (privado) → procesar; cualquier otro remitente o chat de grupo →
 * ignorar SILENCIOSAMENTE. Las respuestas salen SIEMPRE con el mismo token
 * (patrón nova-bridge: "sale por donde se manda").
 *
 * Flujos:
 *  - Mensaje libre durante una sesión de repaso → respuesta = traducción →
 *    se evalúa por palabras clave → POST /review → siguiente tarjeta.
 *  - Botones inline grade0/1/3/4/5 → POST /review → siguiente tarjeta.
 *  - El repaso NO termina por falta de material: vencidas → nuevas →
 *    difíciles → aleatorias → generadas (LLM/pool). Solo "para"/"basta"/"stop".
 *  - Intents simples (translate/stats/pending/start/help) → una respuesta.
 *    "hola"/"inicio" → presentación breve, SIN entrevista.
 */

import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config'
import { createTelegramClient, type TelegramClient, type TelegramUpdate } from './telegram'
import {
  formatReviewCardBack,
  formatReviewCardExplain,
  formatReviewCardFront,
  formatReviewSummary,
  handleSimpleIntent,
  parseIntent,
  reviewBackKeyboard,
  reviewFrontKeyboard,
  reviewKeyboard,
  evaluateAnswer,
  CONTINUE_RE,
  STOP_RE,
  INTRO_TEXT,
  CLARIFICATION_TEXT,
  PHRASE_POOL,
  EN_PHRASE_POOL,
  type IntentDeps,
} from './intents'
import { createDutchClient, type CardDto, type DutchServiceClient } from './dutch'
import { nlBrainOrFallback } from './nl-brain'
import {
  advance,
  currentCard,
  getSession,
  newReviewSession,
  setSession,
} from './session'
import { getUserLanguage, setUserLanguage, type Language } from './user-language'
import type { Brain } from './intents'

/** Nombre legible del idioma activo para el cerebro NL. */
export function languageName(language: Language): string {
  return language === 'en' ? 'inglés' : 'holandés'
}

/**
 * Cerebro redactor de Lingua: cuando el intent devuelve DATOS (traducción,
 * estadísticas, pendientes), el bot construye el contexto real y el LLM
 * redacta la respuesta final en conversación natural, como Hermes. Si el LLM
 * falla (402/timeout) → fallback a la plantilla actual (nunca mudo). El flujo
 * interactivo de repaso (botones, calificación, sesiones) NO pasa por aquí.
 * El idioma activo del usuario se menciona para que la redacción respete el
 * idioma que se está estudiando.
 */
export function buildBrain(language: Language): Brain {
  return async (req) => {
    const system = [
      config.botRole,
      `El usuario está estudiando ${languageName(language).toUpperCase()} ahora mismo: las traducciones y los ejemplos van en ${languageName(language)}.`,
      'Ahora redacta la RESPUESTA FINAL que Lingua envía al usuario por Telegram.',
      'Escríbela en conversación natural, como Hermes: clara, cercana, breve, con emojis y con los datos reales del contexto.',
      'Usa SOLO los datos del contexto: nunca inventes traducciones, cifras ni progresos que no estén ahí.',
      'No enumeres comandos ni ofrezcas listas de opciones salvo que el usuario los pida explícitamente.',
      'Si la petición del usuario es AMBIGUA o le falta información (p. ej. una frase suelta sin contexto), responde con UNA pregunta breve y amable pidiendo solo lo que falta; nunca asumas ni inventes.',
      'Responde solo con el texto final del mensaje, sin preámbulos ni explicaciones de tu proceso.',
    ].join('\n')
    const user = `Petición del usuario: «${req.userText || req.kind}»\n\nDatos reales (${req.kind}):\n${req.context}`
    return nlBrainOrFallback(user, system, req.fallback, 45_000)
  }
}

export interface PollerState {
  polling: boolean
  last_update_ts: number | null
  messages_processed: number
  last_error: string | null
}

export const pollerState: PollerState = {
  polling: false,
  last_update_ts: null,
  messages_processed: 0,
  last_error: null,
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── Helpers puros (unit-testables, sin red) ────────────────────────────────

export function isAuthorized(fromId: number | undefined): boolean {
  return typeof fromId === 'number' && config.authorizedUserIds.includes(fromId)
}

export type Verdict = 'process' | 'ignore'

/** Grupos/foros o remitentes no autorizados → ignorar silenciosamente. */
export function shouldProcess(
  chat: { type?: string; id?: number; title?: string } | undefined,
  fromId: number | undefined
): Verdict {
  if (!chat || chat.type !== 'private') return 'ignore'
  if (!isAuthorized(fromId)) return 'ignore'
  return 'process'
}

/** ¿El texto es un comando que corta la sesión de repaso? */
const COMMAND_RE =
  /^(repaso|repasamos|repasemos|estad[ií]sticas?|estadisticas|pendientes|hola|inicio|ayuda|help|comandos|dame\s+\d+\s+frases|vamos a practicar|sigue|siguiente|otra|para|basta|stop|termina)\b/i

export function isCommand(text: string): boolean {
  return COMMAND_RE.test(text.trim())
}

// ── Offset persistente ─────────────────────────────────────────────────────

const offsetFile = path.join(config.dataDir, 'offset.json')

export function loadOffset(): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(offsetFile, 'utf-8'))
    return typeof parsed.offset === 'number' ? parsed.offset : 0
  } catch {
    return 0
  }
}

export function saveOffset(offset: number): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(offsetFile, JSON.stringify({ offset, saved_at: new Date().toISOString() }))
  } catch {
    /* si no se puede persistir, seguimos con el offset en memoria */
  }
}

// ── Dependencias reales (eva-dutch-service) ────────────────────────────────

/**
 * Dependencias con el idioma activo del usuario ya capturado: todas las
 * llamadas al servicio (translate/queue/cards/stats/due) van con ese idioma.
 * chatId es opcional (los tests inyectan deps sin chat).
 */
export function buildIntentDeps(client: TelegramClient, chatId?: number): IntentDeps {
  const dutch: DutchServiceClient = createDutchClient()
  const language: Language = chatId === undefined ? 'nl' : getUserLanguage(chatId)
  return {
    translate: (text, opts) => dutch.translate(text, { addCard: opts?.addCard ?? false, language }),
    getReviewQueue: (limit) => dutch.getReviewQueue(limit, language),
    getCards: (status, limit) => dutch.getCards(status, limit, language),
    postReview: (cardId, grade, latencyMs) => dutch.postReview(cardId, grade, latencyMs),
    getStats: () => dutch.getStats(language),
    getDueStatus: () => dutch.getDueStatus(language),
    getStudent: () => dutch.getStudent(),
    updateStudent: (patch) => dutch.updateStudent(patch),
    getAudio: (cardId) => dutch.getAudio(cardId),
    sendMessage: (id, t, markup) => client.sendMessage(id, t, markup),
    setLanguage: (id, lang) => setUserLanguage(id, lang),
    // Los intents con DATOS (traducción/estadísticas/pendientes) los redacta
    // el LLM en conversación natural; fallback → plantilla actual.
    brain: buildBrain(language),
  }
}

// ── Flujo de repaso (estilo Anki, por pasos) ───────────────────────────────

/**
 * Paso 1: mensaje de texto con SOLO el front y el botón "Ver traducción",
 * y después (sin bloquear la tarjeta) la nota de voz de pronunciación SIN
 * caption — así el front se muestra UNA sola vez. Si el audio falla (edge-tts
 * lento/caído al generar una tarjeta nueva), se reintenta una vez y se avisa
 * de forma honesta; el repaso nunca se queda mudo ni se queda sin tarjeta.
 */
async function showCard(client: TelegramClient, chatId: number, deps: IntentDeps): Promise<void> {
  const session = getSession(chatId)
  if (!session || session.mode !== 'review') return
  const card = currentCard(session)
  if (!card) return
  if (!session.seen.includes(card.id)) session.seen.push(card.id)
  session.cardShownAt = Date.now()
  session.revealed = false
  session.messageId = null
  // 1) El front, UNA sola vez, con los botones. Siempre llega.
  const sent = await client.sendMessage(chatId, formatReviewCardFront(card), reviewFrontKeyboard())
  session.messageId = sent.message_id
  // 2) Nota de voz de pronunciación (sin caption) en segundo plano.
  void sendCardVoice(client, chatId, card.id, deps)
}

/**
 * Nota de voz de pronunciación. Se envía SIN caption (el front ya está en el
 * mensaje de texto) y NO bloquea la tarjeta: si falla se reintenta una vez y,
 * si sigue fallando, se avisa al usuario en lugar de fallar en silencio.
 */
async function sendCardVoice(client: TelegramClient, chatId: number, cardId: number, deps: IntentDeps): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const audio = await deps.getAudio(cardId)
      await client.sendVoice(chatId, audio)
      return
    } catch (e) {
      const msg = (e as Error).message
      pollerState.last_error = `audio: ${msg}`
      console.error(`dutch-poller: audio card ${cardId} (intento ${attempt}): ${msg}`)
    }
  }
  try {
    await client.sendMessage(chatId, '🔇 No pude generar la pronunciación de esta tarjeta. El repaso sigue igualmente.')
  } catch {
    /* si ni el aviso sale, no hay nada más que hacer */
  }
}

/** Paso 2: el usuario pide la traducción → editar el mensaje (back + calificar). */
async function revealCard(client: TelegramClient, chatId: number): Promise<void> {
  const session = getSession(chatId)
  if (!session || session.mode !== 'review' || session.revealed) return
  const card = currentCard(session)
  if (!card || !session.messageId) return
  session.revealed = true
  await client.editMessageText(chatId, session.messageId, formatReviewCardBack(card), reviewBackKeyboard())
}

/** Paso 3: el usuario pide la explicación → editar el mensaje (explicación + ejemplos). */
async function explainCard(client: TelegramClient, chatId: number): Promise<void> {
  const session = getSession(chatId)
  if (!session || session.mode !== 'review' || !session.revealed) return
  const card = currentCard(session)
  if (!card || !session.messageId) return
  await client.editMessageText(chatId, session.messageId, formatReviewCardExplain(card), reviewKeyboard())
}

async function advanceSession(client: TelegramClient, chatId: number, deps: IntentDeps): Promise<void> {
  const session = getSession(chatId)
  if (!session || session.mode !== 'review') return
  if (advance(session)) {
    await showCard(client, chatId, deps)
  } else {
    await refillSession(client, chatId, deps)
  }
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Genera una tarjeta nueva con una frase del pool básico del idioma activo
 * (vía translate con add_card; el service deduplica: si la frase ya existe
 * devuelve la tarjeta existente). Prefiere frases aún no vistas en la sesión;
 * si todas están vistas, cicla por la primera que funcione — nunca se queda
 * mudo.
 */
async function generateFreshCard(deps: IntentDeps, seen: number[], language: Language): Promise<CardDto | null> {
  const pool = language === 'en' ? EN_PHRASE_POOL : PHRASE_POOL
  let fallback: CardDto | null = null
  for (const phrase of pool) {
    try {
      const t = await deps.translate(phrase, { addCard: true })
      if (!t.card) continue
      if (fallback === null) fallback = t.card
      if (!seen.includes(t.card.id)) return t.card
    } catch {
      /* siguiente frase del pool */
    }
  }
  return fallback
}

/**
 * Carga la siguiente tanda de tarjetas para la sesión de repaso DEL IDIOMA
 * ACTIVO. El repaso NUNCA se queda sin material: primero las vencidas, y si
 * no quedan, continúa con tarjetas nuevas → difíciles → aleatorias → y si la
 * BD está vacía, genera una frase nueva (LLM/pool). Devuelve [] solo si
 * absolutamente nada está disponible.
 */
async function loadMoreCards(deps: IntentDeps, seen: number[], language: Language): Promise<CardDto[]> {
  const unseen = (cards: CardDto[]) => cards.filter((c) => !seen.includes(c.id))

  // 1) Vencidas (cola normal del SRS).
  const due = unseen(await deps.getReviewQueue(10))
  if (due.length > 0) return due

  // 2) Tarjetas nuevas (status 'new').
  const fresh = unseen(await deps.getCards('new', 25))
  if (fresh.length > 0) return fresh

  // 3) Difíciles: las que están en aprendizaje (learning/review) con más
  //    lapses o peor ease primero — las que más cuestan.
  const [learning, review] = await Promise.all([
    deps.getCards('learning', 25),
    deps.getCards('review', 25),
  ])
  const hard = unseen([...learning, ...review]).sort(
    (a, b) => b.lapses - a.lapses || a.ease - b.ease
  )
  if (hard.length > 0) return hard.slice(0, 10)

  // 4) Aleatorias de todo el material (repaso libre).
  const all = unseen(await deps.getCards(undefined, 100))
  if (all.length > 0) return shuffle(all).slice(0, 10)

  // 5) Sin nada en la BD → generar una frase nueva (LLM o pool).
  const generated = await generateFreshCard(deps, seen, language)
  return generated ? [generated] : []
}

/**
 * La cola se agotó: recarga con el siguiente material disponible (vencidas →
 * nuevas → difíciles → aleatorias → generadas). La sesión NO termina por
 * falta de material: solo "para"/"basta"/"stop" la cierran. Si ni siquiera se
 * puede generar (servicio caído), se avisa y el usuario puede reintentar con
 * "sigue" o terminar con "para".
 */
async function refillSession(client: TelegramClient, chatId: number, deps: IntentDeps): Promise<void> {
  const session = getSession(chatId)
  if (!session || session.mode !== 'review') return
  try {
    const more = await loadMoreCards(deps, session.seen, getUserLanguage(chatId))
    if (more.length > 0) {
      setSession(chatId, { ...session, queue: more, idx: 0 })
      await showCard(client, chatId, deps)
    } else {
      await client.sendMessage(
        chatId,
        '😅 No encuentro más tarjetas ni puedo generar nuevas ahora mismo. Di "sigue" para reintentar o "para" para terminar.'
      )
    }
  } catch (e) {
    pollerState.last_error = `refill: ${(e as Error).message}`
    await client.sendMessage(
      chatId,
      '🚨 No pude cargar más tarjetas. Di "sigue" para reintentar o "para" para terminar.'
    )
  }
}

/** "sigue"/"siguiente"/"otra": salta la tarjeta actual sin calificarla y muestra la siguiente. */
async function continueReview(client: TelegramClient, chatId: number, deps: IntentDeps): Promise<void> {
  const session = getSession(chatId)
  if (!session || session.mode !== 'review') return
  await advanceSession(client, chatId, deps)
}

/** "para"/"basta"/"stop"/"termina": termina la sesión con el resumen. */
async function stopReview(client: TelegramClient, chatId: number): Promise<void> {
  const session = getSession(chatId)
  if (!session || session.mode !== 'review') return
  const graded = session.correct + session.wrong
  const summary = formatReviewSummary(session.correct, session.wrong, graded)
  setSession(chatId, null)
  await client.sendMessage(chatId, summary)
}

async function gradeCurrentCard(
  client: TelegramClient,
  chatId: number,
  grade: number,
  deps: IntentDeps,
  extraNote?: string
): Promise<void> {
  const session = getSession(chatId)
  if (!session || session.mode !== 'review') return
  const card = currentCard(session)
  if (!card) return
  const latency = Date.now() - session.cardShownAt
  await deps.postReview(card.id, grade, Math.max(0, latency))
  if (grade < 3) session.wrong += 1
  else session.correct += 1
  if (extraNote) await client.sendMessage(chatId, extraNote)
  await advanceSession(client, chatId, deps)
}

/** Respuesta libre durante el repaso → evaluar por palabras clave. */
async function handleReviewAnswer(client: TelegramClient, chatId: number, text: string, deps: IntentDeps): Promise<void> {
  const session = getSession(chatId)
  if (!session || session.mode !== 'review') return
  const card = currentCard(session)
  if (!card) return
  const { grade, matched } = evaluateAnswer(text, card.back)
  // Si aún no estaba revelada, la revelamos (el usuario respondió al front).
  if (!session.revealed && session.messageId) {
    try {
      await client.editMessageText(chatId, session.messageId, formatReviewCardBack(card), reviewBackKeyboard())
      session.revealed = true
    } catch {
      /* si el edit falla, seguimos igual */
    }
  }
  const note = matched ? '✅ ¡Correcto!' : `❌ La respuesta era: ${card.back}`
  await gradeCurrentCard(client, chatId, grade, deps, note)
}

// ── Procesado de updates ───────────────────────────────────────────────────

export async function handleUpdate(
  client: TelegramClient,
  update: TelegramUpdate,
  depsFactory: (client: TelegramClient, chatId?: number) => IntentDeps = buildIntentDeps
): Promise<void> {
  const message = update.message
  const callback = update.callback_query

  if (callback) {
    if (shouldProcess(callback.message?.chat, callback.from.id) !== 'process') return
    const chatId = callback.message!.chat.id
    await client.answerCallbackQuery(callback.id)
    const data = callback.data ?? ''
    if (data === 'ver-traduccion') {
      await revealCard(client, chatId)
      return
    }
    if (data === 'explicacion') {
      await explainCard(client, chatId)
      return
    }
    const gradeMatch = /^grade([0-5])$/.exec(data)
    if (gradeMatch) {
      await gradeCurrentCard(client, chatId, Number(gradeMatch[1]), depsFactory(client, chatId))
    }
    return
  }

  if (!message?.chat) return
  if (shouldProcess(message.chat, message.from?.id) !== 'process') return

  const chatId = message.chat.id
  const text = (message.text ?? message.caption ?? '').trim()
  const deps = depsFactory(client, chatId)

  // Sesión activa de repaso: comandos de control (sigue/para) o respuesta libre.
  const session = getSession(chatId)
  if (session?.mode === 'review' && text) {
    if (CONTINUE_RE.test(text)) {
      await continueReview(client, chatId, deps)
      pollerState.messages_processed += 1
      return
    }
    if (STOP_RE.test(text)) {
      await stopReview(client, chatId)
      pollerState.messages_processed += 1
      return
    }
  }
  if (session?.mode === 'review' && text && !isCommand(text)) {
    await handleReviewAnswer(client, chatId, text, deps)
    pollerState.messages_processed += 1
    return
  }

  const intent = parseIntent(text)

  if (intent.type === 'review') {
    try {
      // El repaso no termina por falta de material: si no hay vencidas, se
      // continúa con nuevas/difíciles/aleatorias y, si la BD está vacía, se
      // genera una frase nueva (LLM/pool). Todo en el idioma activo.
      const cards = await loadMoreCards(deps, [], getUserLanguage(chatId))
      if (cards.length === 0) {
        await client.sendMessage(
          chatId,
          '😅 No encuentro tarjetas para repasar ni puedo generar frases nuevas ahora mismo. Inténtalo en un momento.'
        )
      } else {
        setSession(chatId, newReviewSession(cards))
        await showCard(client, chatId, deps)
      }
    } catch (e) {
      pollerState.last_error = `review: ${(e as Error).message}`
      await client.sendMessage(chatId, '🚨 No pude preparar el repaso. Inténtalo en un momento.')
    }
  } else if (intent.type === 'start') {
    // Saludo breve y amable: SIN entrevista ni preguntas progresivas.
    await client.sendMessage(chatId, INTRO_TEXT)
  } else if (intent.type === 'chat') {
    // Cerebro de lenguaje natural: sin intent determinista → el LLM responde
    // con el rol de Lingua (fail-closed), MENCIONANDO el idioma activo del
    // usuario. Si el LLM falla → pregunta breve y amable en lenguaje natural
    // (NUNCA el menú de comandos).
    const language = getUserLanguage(chatId)
    const system = [
      config.botRole,
      `El usuario está estudiando ${languageName(language).toUpperCase()} ahora mismo: las traducciones y los ejemplos van en ${languageName(language)}.`,
    ].join('\n')
    const nl = await nlBrainOrFallback(text, system, CLARIFICATION_TEXT)
    if (nl.response) {
      try {
        await client.sendMessage(chatId, nl.response)
      } catch (e) {
        pollerState.last_error = `sendMessage: ${(e as Error).message}`
      }
    }
    console.log(`dutch-poller: cerebro NL (${nl.brain}, ${language}) para: ${text.slice(0, 80)}`)
  } else {
    let response: string
    try {
      response = await handleSimpleIntent(intent, deps, chatId, text)
    } catch (e) {
      pollerState.last_error = `intent: ${(e as Error).message}`
      response = '🚨 No pude procesar tu petición. Inténtalo en un momento.'
    }
    if (response) {
      try {
        await client.sendMessage(chatId, response)
      } catch (e) {
        pollerState.last_error = `sendMessage: ${(e as Error).message}`
      }
    }
  }

  pollerState.messages_processed += 1
  pollerState.last_update_ts = Date.now()
  console.log(`dutch-poller: mensaje de ${message.from?.id ?? '?'} → intent ${intent.type}`)
}

// ── Bucle de polling ───────────────────────────────────────────────────────

export async function startPoller(): Promise<void> {
  const token = config.botToken
  if (!token) {
    pollerState.last_error = 'DUTCH_BOT_TOKEN no configurado'
    console.error(`dutch-poller: ${pollerState.last_error}`)
    return
  }
  const client = createTelegramClient({ token })
  let offset = loadOffset()
  pollerState.polling = true
  console.log(`dutch-poller: polling del bot de Lingua desde offset ${offset} (timeout ${config.pollTimeoutSec}s)`)

  for (;;) {
    try {
      const updates = await client.getUpdates(offset, config.pollTimeoutSec)
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1)
        saveOffset(offset)
        try {
          await handleUpdate(client, u)
        } catch (e) {
          pollerState.last_error = `handleUpdate: ${(e as Error).message}`
        }
      }
      pollerState.last_error = null
    } catch (e) {
      const err = e as Error & { code?: number }
      pollerState.last_error = err.message
      if (err.code === 409) {
        // Conflicto de polling: otro proceso usa el token.
        console.error('dutch-poller: 409 conflicto de polling — reintento en 15s')
        await sleep(15_000)
      } else {
        console.error(`dutch-poller: ${err.message} — reintento en 5s`)
        await sleep(5_000)
      }
    }
  }
}
