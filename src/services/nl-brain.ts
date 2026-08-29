/**
 * Cerebro de lenguaje natural (Lingua): cuando el intent determinista no
 * coincide, el bot pide respuesta al api_server del VPS (daemon
 * OpenAI-compatible en http://127.0.0.1:8642, modelo "hermes").
 *
 * Patrón compartido con eva-nova-bridge (services/hermes-api.ts) y con los
 * otros bots (Mibu, Ares): mismo contrato, mismo fallback.
 *
 * SIEMPRE con fallback: si el LLM falla (error/402/timeout) → el bot responde
 * con su ayuda actual (fallbackText) — nunca se queda mudo.
 */

import fs from 'node:fs'

export const API_SERVER_URL =
  process.env.API_SERVER_URL ?? 'http://127.0.0.1:8642/v1/chat/completions'
/** Dónde se lee API_SERVER_KEY (el .env raíz del contenedor). */
export const API_SERVER_ENV_PATH = process.env.API_SERVER_ENV_PATH ?? '/opt/data/.env'

export interface NlBrainResult {
  response: string
  timeMs: number
}

let cachedKey: string | null | undefined

/** Lee API_SERVER_KEY de /opt/data/.env (o process.env si ya está exportada). Nunca se expone en errores. */
export function readApiServerKey(envPath: string = API_SERVER_ENV_PATH): string | null {
  if (cachedKey !== undefined) return cachedKey
  if (process.env.API_SERVER_KEY) {
    cachedKey = process.env.API_SERVER_KEY
    return cachedKey
  }
  try {
    const content = fs.readFileSync(envPath, 'utf-8')
    for (const line of content.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?API_SERVER_KEY\s*=\s*(.+?)\s*$/.exec(line)
      if (!m) continue
      let value = m[1].trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      cachedKey = value
      return cachedKey
    }
  } catch {
    /* se reporta abajo como error descriptivo, sin detalle del archivo */
  }
  cachedKey = null
  return null
}

/** Limpia la caché de la key (útil en tests). */
export function resetApiServerKeyCache(): void {
  cachedKey = undefined
}

/**
 * Pide respuesta al api_server persistente.
 * @throws Error descriptivo en timeout / red / HTTP (nunca expone la key).
 */
export async function runNlBrain(
  userMessage: string,
  systemPrompt: string,
  timeoutMs = 60_000
): Promise<NlBrainResult> {
  const key = readApiServerKey()
  if (!key) {
    throw new Error('runNlBrain: no se encontró API_SERVER_KEY en /opt/data/.env')
  }

  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(API_SERVER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'hermes',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`el api_server respondió HTTP ${res.status}`)
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('la respuesta no traía choices[0].message.content')
    }
    return { response: content, timeMs: Date.now() - start }
  } catch (e) {
    const err = e as Error
    if (err.name === 'AbortError') {
      throw new Error(`runNlBrain: timeout tras ${timeoutMs}ms sin respuesta del api_server`)
    }
    throw new Error(`runNlBrain: no se pudo contactar con el api_server (${err.message})`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fallback SIEMPRE disponible: intenta el LLM; si falla (error/402/timeout)
 * devuelve fallbackText (la ayuda actual del bot). Nunca lanza, nunca deja
 * mudo al bot.
 */
export async function nlBrainOrFallback(
  userMessage: string,
  systemPrompt: string,
  fallbackText: string,
  timeoutMs?: number
): Promise<{ response: string; brain: 'nl' | 'fallback' }> {
  try {
    const result = await runNlBrain(userMessage, systemPrompt, timeoutMs)
    return { response: result.response, brain: 'nl' }
  } catch (e) {
    console.error(`nl-brain: LLM no disponible (${(e as Error).message}) — fallback a la ayuda`)
    return { response: fallbackText, brain: 'fallback' }
  }
}
