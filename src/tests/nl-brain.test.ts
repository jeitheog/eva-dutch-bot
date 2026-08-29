/**
 * Tests del cerebro de lenguaje natural (nl-brain.ts) — node:test, sin red
 * real: se mockea fetch para verificar el fallback fail-closed (error/402/
 * timeout → fallbackText, el bot nunca se queda mudo).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  nlBrainOrFallback,
  readApiServerKey,
  resetApiServerKeyCache,
  runNlBrain,
} from '../services/nl-brain'
import { config } from '../config'
import { HELP_TEXT } from '../services/intents'

const FALLBACK = HELP_TEXT

test('nlBrainOrFallback: el rol del bot (config.botRole) define el sistema', async () => {
  resetApiServerKeyCache()
  const captured: {
    body: { model: string; messages: Array<{ role: string; content: string }> } | null
  } = { body: null }
  const original = globalThis.fetch
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    captured.body = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hola 👋' } }] }),
      { status: 200 }
    )
  }) as typeof fetch
  try {
    const { response, brain } = await nlBrainOrFallback('hola', config.botRole, FALLBACK, 5_000)
    assert.equal(brain, 'nl')
    assert.equal(response, 'hola 👋')
    assert.ok(captured.body, 'se envió body al api_server')
    assert.equal(captured.body!.model, 'hermes')
    assert.equal(captured.body!.messages[0].role, 'system')
    assert.equal(captured.body!.messages[0].content, config.botRole)
    assert.equal(captured.body!.messages[1].role, 'user')
    assert.equal(captured.body!.messages[1].content, 'hola')
  } finally {
    globalThis.fetch = original
  }
})

test('nlBrainOrFallback: HTTP 402 (sin crédito) → fallback a la ayuda, nunca mudo', async () => {
  resetApiServerKeyCache()
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response('sin crédito', { status: 402 })) as typeof fetch
  try {
    const { response, brain } = await nlBrainOrFallback('cualquier cosa', config.botRole, FALLBACK, 5_000)
    assert.equal(brain, 'fallback')
    assert.equal(response, FALLBACK)
  } finally {
    globalThis.fetch = original
  }
})

test('nlBrainOrFallback: HTTP 500 → fallback a la ayuda', async () => {
  resetApiServerKeyCache()
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch
  try {
    const { brain, response } = await nlBrainOrFallback('hola', config.botRole, FALLBACK, 5_000)
    assert.equal(brain, 'fallback')
    assert.equal(response, FALLBACK)
  } finally {
    globalThis.fetch = original
  }
})

test('nlBrainOrFallback: timeout → fallback a la ayuda', async () => {
  resetApiServerKeyCache()
  const original = globalThis.fetch
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError'))
      )
    })) as typeof fetch
  try {
    const { brain, response } = await nlBrainOrFallback('hola', config.botRole, FALLBACK, 1_000)
    assert.equal(brain, 'fallback')
    assert.equal(response, FALLBACK)
  } finally {
    globalThis.fetch = original
  }
})

test('readApiServerKey: sin key en el archivo → null (sin excepción)', () => {
  resetApiServerKeyCache()
  assert.equal(readApiServerKey('/tmp/inexistente-para-test/.env'), null)
  resetApiServerKeyCache()
})

test('runNlBrain: respuesta vacía → Error descriptivo', async () => {
  resetApiServerKeyCache()
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' } }] }), {
      status: 200,
    })) as typeof fetch
  try {
    await assert.rejects(() => runNlBrain('hola', config.botRole, 5_000), /choices/)
  } finally {
    globalThis.fetch = original
  }
})
