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
 *  - Entrevista progresiva (hola): nombre → profesión → hobbies → /student.
 *  - Intents simples (translate/stats/pending/start/help) → una respuesta.
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
  type IntentDeps,
} from './intents'
import { createDutchClient, type DutchServiceClient } from './dutch'
import {
  advance,
  currentCard,
  getSession,
  interviewQuestion,
  newReviewSession,
  setSession,
} from './session'

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

export function buildIntentDeps(client: TelegramClient): IntentDeps {
  const dutch: DutchServiceClient = createDutchClient()
  return {
    translate: (text, opts) => dutch.translate(text, { addCard: opts?.addCard ?? false }),
    getReviewQueue: (limit) => dutch.getReviewQueue(limit),
    postReview: (cardId, grade, latencyMs) => dutch.postReview(cardId, grade, latencyMs),
    getStats: () => dutch.getStats(),
    getDueStatus: () => dutch.getDueStatus(),
    getStudent: () => dutch.getStudent(),
    updateStudent: (patch) => dutch.updateStudent(patch),
    sendMessage: (id, t, markup) => client.sendMessage(id, t, markup),
  }
}

// ── Flujo de repaso (estilo Anki, por pasos) ───────────────────────────────

/** Paso 1: nuevo mensaje con SOLO el front + botón "Ver traducción". */
async function showCard(client: TelegramClient, chatId: number): Promise<void> {
  const session = getSession(chatId)
  if (!session || session.mode !== 'review') return
  const card = currentCard(session)
  if (!card) return
  if (!session.seen.includes(card.id)) session.seen.push(card.id)
  session.cardShownAt = Date.now()
  session.revealed = false
  session.messageId = null
  const sent = await client.sendMessage(chatId, formatReviewCardFront(card), reviewFrontKeyboard())
  session.messageId = sent.message_id
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
    await showCard(client, chatId)
  } else {
    await refillOrEnd(client, chatId, deps)
  }
}

/**
 * La cola se agotó: recarga más tarjetas vencidas (sin límite de N) o
 * termina la sesión. Las tarjetas ya mostradas en esta sesión se filtran
 * para no repetirlas (las saltadas con "sigue" siguen vencidas).
 */
async function refillOrEnd(client: TelegramClient, chatId: number, deps: IntentDeps): Promise<void> {
  const session = getSession(chatId)
  if (!session || session.mode !== 'review') return
  try {
    const more = (await deps.getReviewQueue(10)).filter((c) => !session.seen.includes(c.id))
    if (more.length > 0) {
      setSession(chatId, { ...session, queue: more, idx: 0 })
      await showCard(client, chatId)
    } else {
      const graded = session.correct + session.wrong
      const summary = formatReviewSummary(session.correct, session.wrong, graded)
      setSession(chatId, null)
      await client.sendMessage(chatId, summary + '\nSe acabaron las pendientes — ¿te genero más? (o añade frases)')
    }
  } catch (e) {
    pollerState.last_error = `refill: ${(e as Error).message}`
    setSession(chatId, null)
    await client.sendMessage(chatId, '🚨 No pude cargar más tarjetas. Termino la sesión aquí.')
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

// ── Entrevista progresiva ──────────────────────────────────────────────────

async function handleInterviewAnswer(client: TelegramClient, chatId: number, text: string): Promise<void> {
  const session = getSession(chatId)
  if (!session || session.mode !== 'interview') return
  const deps = buildIntentDeps(client)
  const step = session.step
  if (step === 'nombre') {
    await deps.updateStudent({ nombre: text.trim() })
    setSession(chatId, { mode: 'interview', step: 'profesion' })
    await client.sendMessage(chatId, interviewQuestion('profesion'))
  } else if (step === 'profesion') {
    await deps.updateStudent({ profesion: text.trim() })
    setSession(chatId, { mode: 'interview', step: 'hobbies' })
    await client.sendMessage(chatId, interviewQuestion('hobbies'))
  } else {
    const hobbies = text
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean)
    await deps.updateStudent({ hobbies })
    setSession(chatId, null)
    await client.sendMessage(
      chatId,
      '¡Perfecto! Ya te conozco un poco mejor 😊\nDi "repaso" cuando quieras practicar, o "¿cómo se dice <frase>?" para aprender algo nuevo.'
    )
  }
}

// ── Procesado de updates ───────────────────────────────────────────────────

export async function handleUpdate(
  client: TelegramClient,
  update: TelegramUpdate,
  depsFactory: (client: TelegramClient) => IntentDeps = buildIntentDeps
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
      await gradeCurrentCard(client, chatId, Number(gradeMatch[1]), depsFactory(client))
    }
    return
  }

  if (!message?.chat) return
  if (shouldProcess(message.chat, message.from?.id) !== 'process') return

  const chatId = message.chat.id
  const text = (message.text ?? message.caption ?? '').trim()
  const deps = depsFactory(client)

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
  if (session?.mode === 'interview' && text && !isCommand(text)) {
    await handleInterviewAnswer(client, chatId, text)
    pollerState.messages_processed += 1
    return
  }

  const intent = parseIntent(text)

  if (intent.type === 'review') {
    try {
      const queue = await deps.getReviewQueue(10)
      if (queue.length === 0) {
        await client.sendMessage(chatId, 'Se acabaron las pendientes — ¿te genero más? (o añade frases)')
      } else {
        setSession(chatId, newReviewSession(queue))
        await showCard(client, chatId)
      }
    } catch (e) {
      pollerState.last_error = `review: ${(e as Error).message}`
      await client.sendMessage(chatId, '🚨 No pude preparar el repaso. Inténtalo en un momento.')
    }
  } else if (intent.type === 'start') {
    const isKnown = await deps
      .getStudent()
      .then((s) => Boolean(s.nombre))
      .catch(() => false)
    if (isKnown) {
      await client.sendMessage(
        chatId,
        '🎓 ¡Hola de nuevo! Di "repaso" para practicar o "¿cómo se dice <frase>?" para aprender algo nuevo.'
      )
    } else {
      setSession(chatId, { mode: 'interview', step: 'nombre' })
      await client.sendMessage(chatId, INTRO_TEXT)
    }
  } else {
    let response: string
    try {
      response = await handleSimpleIntent(intent, deps, chatId)
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
