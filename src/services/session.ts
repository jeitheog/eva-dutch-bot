/**
 * Sesiones de Lingua: repaso (cola de tarjetas + botones SM-2). Estado en
 * memoria, una sesión por chat (solo Jei/Jessi, chat privado).
 */

import type { CardDto } from './dutch'

export interface ReviewSession {
  mode: 'review'
  queue: CardDto[]
  idx: number
  correct: number
  wrong: number
  cardShownAt: number
  /** ¿La traducción ya está visible? (flujo Anki por pasos). */
  revealed: boolean
  /** message_id del mensaje con la tarjeta actual (para editar en el paso 2/3). */
  messageId: number | null
  /** ids de tarjetas ya mostradas en esta sesión (evita repetirlas al recargar la cola). */
  seen: number[]
}

export type Session = ReviewSession | null

export const sessions = new Map<number, Session>()

export function getSession(chatId: number): Session {
  return sessions.get(chatId) ?? null
}

export function setSession(chatId: number, session: Session): void {
  if (session === null) sessions.delete(chatId)
  else sessions.set(chatId, session)
}

export function newReviewSession(queue: CardDto[]): ReviewSession {
  return { mode: 'review', queue, idx: 0, correct: 0, wrong: 0, cardShownAt: Date.now(), revealed: false, messageId: null, seen: [] }
}

export function currentCard(s: ReviewSession): CardDto | undefined {
  return s.queue[s.idx]
}

/** Avanza al siguiente índice; devuelve false si la sesión terminó. */
export function advance(s: ReviewSession): boolean {
  s.idx += 1
  return s.idx < s.queue.length
}
