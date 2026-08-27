/**
 * Cliente HTTP de eva-dutch-service (3022) — auth x-dutch-service-api-key.
 * Sin lógica: solo transporte + tipado de las respuestas de la API.
 */

import { config } from '../config'

export interface CardDto {
  id: number
  type: 'phrase' | 'word'
  front: string
  back: string
  nl: string
  es: string
  pronunciation: string
  explanation: string
  grammar: string
  examples: string
  context: string
  category: string
  source: string
  created_at: number
  due_at: number
  interval_days: number
  ease: number
  repetitions: number
  lapses: number
  status: string
}

export interface TranslateResponse {
  nl: string
  es: string
  pronunciation: string
  explanation: string
  examples: string[]
  used_llm: boolean
  duplicate?: boolean
  existing_id?: number
  card?: CardDto
}

export interface StatsResponse {
  total: number
  nuevas: number
  aprendiendo: number
  dominadas: number
  dificiles: number
  pendientes_hoy: number
  racha: number
  aciertos_pct: number
  por_categoria: Record<string, number>
}

export interface DueStatusResponse {
  pendientes_hoy: number
  nuevas_disponibles: number
  dificiles: number
}

export interface StudentResponse {
  id: number
  nombre: string
  nivel: string
  profesion: string
  hobbies: string
  objetivos: string
  situaciones: string
  dificultades: string
  preferencia_metodo: string
  updated_at: number
}

export interface DutchServiceClient {
  translate(text: string, opts?: { addCard?: boolean; type?: string; category?: string }): Promise<TranslateResponse>
  getReviewQueue(limit?: number): Promise<CardDto[]>
  postReview(cardId: number, grade: number, latencyMs: number): Promise<{ ok: boolean; card: CardDto }>
  getStats(): Promise<StatsResponse>
  getDueStatus(): Promise<DueStatusResponse>
  getStudent(): Promise<StudentResponse>
  updateStudent(patch: Record<string, unknown>): Promise<StudentResponse>
  /** Audio ogg de pronunciación de una tarjeta (generado bajo demanda por el service). */
  getAudio(cardId: number): Promise<Uint8Array>
  health(): Promise<{ ok: boolean }>
}

export function createDutchClient(opts: { baseUrl?: string; apiKey?: string; fetchImpl?: typeof fetch } = {}): DutchServiceClient {
  const baseUrl = opts.baseUrl ?? config.serviceBaseUrl
  const apiKey = opts.apiKey ?? config.serviceApiKey
  const fetchImpl = opts.fetchImpl ?? fetch

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-dutch-service-api-key': apiKey,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`eva-dutch-service ${method} ${path}: HTTP ${res.status} ${detail.slice(0, 200)}`)
    }
    return (await res.json()) as T
  }

  return {
    translate: (text, opts = {}) =>
      call<TranslateResponse>('POST', '/api/v1/dutch/translate', {
        text,
        direction: 'auto',
        add_card: opts.addCard ?? false,
        type: opts.type,
        category: opts.category,
      }),
    getReviewQueue: (limit = 10) => call<{ cards: CardDto[] }>('GET', `/api/v1/dutch/review/queue?limit=${limit}`).then((r) => r.cards),
    postReview: (cardId, grade, latencyMs) =>
      call<{ ok: boolean; card: CardDto }>('POST', '/api/v1/dutch/review', { card_id: cardId, grade, latency_ms: latencyMs }),
    getStats: () => call<StatsResponse>('GET', '/api/v1/dutch/stats'),
    getDueStatus: () => call<DueStatusResponse>('GET', '/api/v1/dutch/due/status'),
    getStudent: () => call<StudentResponse>('GET', '/api/v1/dutch/student'),
    updateStudent: (patch) => call<StudentResponse>('POST', '/api/v1/dutch/student', patch),
    getAudio: async (cardId) => {
      const res = await fetchImpl(`${baseUrl}/api/v1/dutch/audio/${cardId}`, {
        headers: { 'x-dutch-service-api-key': apiKey },
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(
          `eva-dutch-service GET /api/v1/dutch/audio/${cardId}: HTTP ${res.status} ${detail.slice(0, 200)}`
        )
      }
      return new Uint8Array(await res.arrayBuffer())
    },
    health: () => call<{ ok: boolean }>('GET', '/health'),
  }
}
