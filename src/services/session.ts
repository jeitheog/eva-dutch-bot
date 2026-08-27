/**
 * Sesiones de Lingua: repaso (cola de tarjetas + botones SM-2) y entrevista
 * progresiva (nombre → profesión → hobbies → /student). Estado en memoria,
 * una sesión por chat (solo Jei, chat privado).
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
}

export interface InterviewSession {
  mode: 'interview'
  step: 'nombre' | 'profesion' | 'hobbies'
}

export type Session = ReviewSession | InterviewSession | null

export const sessions = new Map<number, Session>()

export function getSession(chatId: number): Session {
  return sessions.get(chatId) ?? null
}

export function setSession(chatId: number, session: Session): void {
  if (session === null) sessions.delete(chatId)
  else sessions.set(chatId, session)
}

export function newReviewSession(queue: CardDto[]): ReviewSession {
  return { mode: 'review', queue, idx: 0, correct: 0, wrong: 0, cardShownAt: Date.now(), revealed: false, messageId: null }
}

export function currentCard(s: ReviewSession): CardDto | undefined {
  return s.queue[s.idx]
}

/** Avanza al siguiente índice; devuelve false si la sesión terminó. */
export function advance(s: ReviewSession): boolean {
  s.idx += 1
  return s.idx < s.queue.length
}

/** Preguntas de la entrevista progresiva. */
export function interviewQuestion(step: InterviewSession['step']): string {
  switch (step) {
    case 'nombre':
      return '¿Cómo te llamas?'
    case 'profesion':
      return 'Encantado. ¿A qué te dedicas?'
    case 'hobbies':
      return 'Genial. ¿Cuáles son tus hobbies? (sepáralos con comas)'
  }
}
