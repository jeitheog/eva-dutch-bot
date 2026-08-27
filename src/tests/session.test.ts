/**
 * Tests de la sesión de repaso (cola, avance, resumen) y del recordatorio
 * (máx 1/día) — node:test, sin red.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advance, currentCard, newReviewSession, setSession, getSession, sessions } from '../services/session'
import { formatReviewSummary, formatReviewCard } from '../services/intents'
import { todayKey } from '../services/reminder'
import type { CardDto } from '../services/dutch'

function makeCard(id: number, front: string, back: string): CardDto {
  return {
    id, type: 'phrase', front, back, nl: front, es: back, pronunciation: '', explanation: '',
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

test('formato de tarjeta en repaso incluye front y pronunciación', () => {
  const card = makeCard(1, 'Geef me de halter even', 'Dame la mancuerna un momento')
  const text = formatReviewCard({ ...card, pronunciation: 'jeef me de jálter éven' })
  assert.ok(text.includes('Geef me de halter even'))
  assert.ok(text.includes('jeef me de jálter éven'))
})

test('sessions por chat: set/get independientes', () => {
  setSession(111, { mode: 'review', queue: [], idx: 0, correct: 0, wrong: 0, cardShownAt: 0 })
  setSession(222, { mode: 'interview', step: 'nombre' })
  assert.equal(getSession(111)?.mode, 'review')
  assert.equal(getSession(222)?.mode, 'interview')
  setSession(111, null)
  assert.equal(getSession(111), null)
  sessions.clear()
})

test('recordatorio: todayKey formato YYYY-MM-DD', () => {
  assert.match(todayKey(), /^\d{4}-\d{2}-\d{2}$/)
})
