/**
 * Tests de la sesión de repaso (cola, avance, resumen) y del recordatorio
 * (máx 1/día) — node:test, sin red.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advance, currentCard, newReviewSession, setSession, getSession, sessions } from '../services/session'
import {
  formatReviewSummary,
  formatReviewCardBack,
  formatReviewCardExplain,
  formatReviewCardFront,
  reviewBackKeyboard,
  reviewFrontKeyboard,
} from '../services/intents'
import { todayKey } from '../services/reminder'
import type { CardDto } from '../services/dutch'

function makeCard(id: number, front: string, back: string): CardDto {
  return {
    id, type: 'phrase', language: 'nl', front, back, nl: front, es: back, pronunciation: '', explanation: '',
    grammar: '', examples: '[]', context: '', category: 'general', source: 'manual',
    created_at: 0, due_at: 0, interval_days: 0, ease: 2.5, repetitions: 0, lapses: 0, status: 'new',
  }
}

test('sesión de repaso: muestra una a una y termina con resumen', () => {
  const queue = [makeCard(1, 'Hallo', 'Hola'), makeCard(2, 'Dank je', 'Gracias')]
  const s = newReviewSession(queue)
  assert.equal(s.idx, 0)
  assert.equal(currentCard(s)?.id, 1)
  assert.ok(advance(s))
  assert.equal(currentCard(s)?.id, 2)
  assert.ok(!advance(s), 'cola agotada')
  const summary = formatReviewSummary(1, 1, 2)
  assert.ok(summary.includes('2 tarjetas'))
  assert.ok(summary.includes('1 bien'))
})

test('formato de tarjeta en repaso: front solo → back → explicación (Anki por pasos)', () => {
  const card = makeCard(1, 'Geef me de halter even', 'Dame la mancuerna un momento')
  const front = formatReviewCardFront(card)
  assert.equal(front, '🎴 Geef me de halter even')
  assert.ok(!front.includes('Dame la mancuerna'), 'el front NO muestra la traducción')

  const back = formatReviewCardBack({ ...card, pronunciation: 'jeef me de jálter éven' })
  assert.ok(back.includes('Geef me de halter even'))
  assert.ok(back.includes('Dame la mancuerna un momento'))
  assert.ok(back.includes('jeef me de jálter éven'))
  assert.ok(!back.includes('📖'), 'el back NO adelanta la explicación')

  const explain = formatReviewCardExplain({
    ...card,
    explanation: 'geef me = dame; halter = mancuerna; even suaviza la petición',
    examples: JSON.stringify(['Geef me even de handdoek — Pásame la toalla un segundo']),
  })
  assert.ok(explain.includes('📖 geef me = dame'))
  assert.ok(explain.includes('Pásame la toalla un segundo'))
})

test('teclados del repaso: front (ver traducción) y back (explicación + grades)', () => {
  const frontKb = reviewFrontKeyboard()
  assert.deepEqual(frontKb.inline_keyboard.flat().map((b) => b.callback_data), ['ver-traduccion'])
  const backKb = reviewBackKeyboard()
  const data = backKb.inline_keyboard.flat().map((b) => b.callback_data)
  assert.deepEqual(data, ['explicacion', 'grade0', 'grade1', 'grade3', 'grade4', 'grade5'])
})

test('sessions por chat: set/get independientes', () => {
  setSession(111, { mode: 'review', queue: [], idx: 0, correct: 0, wrong: 0, cardShownAt: 0, revealed: false, messageId: null, seen: [] })
  assert.equal(getSession(111)?.mode, 'review')
  setSession(111, null)
  assert.equal(getSession(111), null)
  sessions.clear()
})

test('recordatorio: todayKey formato YYYY-MM-DD', () => {
  assert.match(todayKey(), /^\d{4}-\d{2}-\d{2}$/)
})
