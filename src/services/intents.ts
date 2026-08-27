/**
 * Intents de Lingua (eva-dutch-bot). Interpreta el texto libre en español
 * y lo resuelve contra eva-dutch-service (3022). Toda la lógica es pura:
 * los tests no tocan red ni disco.
 */

import type {
  CardDto,
  DueStatusResponse,
  StatsResponse,
  StudentResponse,
  TranslateResponse,
} from './dutch'
import type { InlineKeyboardButton } from './telegram'

export type Intent =
  | { type: 'translate'; text: string }
  | { type: 'review' }
  | { type: 'stats' }
  | { type: 'pending' }
  | { type: 'start' }
  | { type: 'help' }

export const HELP_TEXT = [
  '🎓 Lingua — tu profesor de holandés. Comandos:',
  '• "¿cómo se dice <frase>?" — traduce y te la añade a tus tarjetas',
  '• "aprender esta frase: <frase>" — igual, para frases largas',
  '• "repaso" / "dame 10 frases" — sesión de repaso con botones',
  '• "sigue" / "siguiente" / "otra" — durante un repaso, pasa a la siguiente tarjeta (sin parar hasta que digas "para")',
  '• "para" / "basta" / "stop" / "termina" — termina la sesión de repaso con el resumen',
  '• "estadísticas" — tu progreso',
  '• "pendientes" — cuántas frases te quedan para hoy',
  '• "hola" — presentación breve (sin entrevista): te explico qué puedo hacer',
].join('\n')

/**
 * Comandos de control de la sesión de repaso (texto libre, no botones):
 * CONTINUE_RE → saltar a la siguiente tarjeta (recargando la cola si se
 * agotó, sin límite de N); STOP_RE → terminar la sesión con el resumen.
 */
export const CONTINUE_RE = /^(sigue|siguiente frase|siguiente tarjeta|siguiente|otra)\b/i
export const STOP_RE = /^(para|basta|stop|termina|terminar)\b/i

export const INTRO_TEXT = [
  '🎓 ¡Hola! Soy Lingua, tu profesor de holandés.',
  'Puedo traducirte frases, guardarlas y repasar contigo cada día.',
  'Prueba: "¿cómo se dice <frase>?" para aprender algo nuevo,',
  '"repaso" para practicar, "estadísticas" para ver tu progreso',
  'o "ayuda" para ver todos los comandos.',
].join('\n')

/**
 * Pool de frases básicas (NL): si la BD se queda sin tarjetas durante un
 * repaso, el bot genera una tarjeta nueva con estas frases (vía translate
 * con add_card) para que la sesión nunca se quede muda. El service deduplica
 * por front/nl, así que si la frase ya existe devuelve la tarjeta existente.
 */
export const PHRASE_POOL: string[] = [
  'dank je wel',
  'goedemorgen',
  'goedenavond',
  'tot ziens',
  'alsjeblieft',
  'hoe gaat het met je',
  'ik begrijp het niet',
  'waar is het station',
  'hoeveel kost dit',
  'ik wil graag een koffie',
  'een biertje, alsjeblieft',
  'de rekening, graag',
  'ik hou van je',
  'tot morgen',
  'wat is dit',
  'ik leer Nederlands',
  'spreek je Engels',
  'ik heb een vraag',
  'geef me even de tijd',
  'het spijt me',
]

/** Extrae el texto a traducir tras el prefijo de intent (permite ¿ inicial). */
const TRANSLATE_RE =
  /^¿?\s*(?:aprender\s+(?:esta frase|a decir|la frase)\s*:?\s*|aprender\s*:?\s*|guarda\s+(?:esta\s+)?(?:palabra|frase)\s*:?\s*|guarda\s*:?\s*|quiero aprender a decir\s*:?\s*|c[oó]mo se dice\s*:?\s*|dime c[oó]mo se dice\s*:?\s*)(.+)$/i

export function parseIntent(raw: string): Intent {
  const text = (raw ?? '').trim()
  if (!text) return { type: 'help' }

  const translateMatch = text.match(TRANSLATE_RE)
  if (translateMatch) return { type: 'translate', text: translateMatch[1].trim().replace(/[¿?]+$/, '') }

  const lower = text.toLowerCase().replace(/^[¿?¡!]+/, '').replace(/[¿?]+$/, '')
  if (/^(repaso|repasamos|repasemos|repasito|vamos a practicar|practiquemos|practicar|a repasar|dame\s+\d+\s+frases|dame\s+frases|examen r[aá]pido|solo palabras dif[íi]ciles|sigue|siguiente|otra|empezamos)\b/.test(lower)) {
    return { type: 'review' }
  }
  if (/^(estad[ií]sticas?|estadisticas|progreso|mi progreso|resumen)\b/.test(lower)) {
    return { type: 'stats' }
  }
  if (/^(pendientes|cu[aá]ntas (frases|tarjetas) (pendientes|me quedan)|qu[eé] me queda|para hoy)\b/.test(lower)) {
    return { type: 'pending' }
  }
  if (/^(hola|inicio|empezar|buenas|hey|ayuda|help|comandos|qu[eé] puedes hacer)\b/.test(lower)) {
    return { type: 'start' }
  }
  return { type: 'help' }
}

// ── Formato de respuestas ──────────────────────────────────────────────────

export function formatCardCreated(t: TranslateResponse): string {
  const card = t.card
  if (t.duplicate) return 'Ya la tienes 😊'
  const lines = [
    '✅ Perfecto. Te la añado a tus tarjetas:',
    `📌 ${card?.nl ?? t.nl}`,
    `💬 ${card?.es ?? t.es}`,
  ]
  if (t.pronunciation) lines.push(`🗣 ${t.pronunciation}`)
  if (t.explanation) lines.push(`📖 ${t.explanation}`)
  if (t.examples && t.examples.length > 0) {
    lines.push('✨ Ejemplos:')
    for (const ex of t.examples.slice(0, 3)) lines.push(`• ${ex}`)
  }
  return lines.join('\n')
}

export function formatStats(s: StatsResponse): string {
  return [
    `📊 Tus estadísticas:`,
    `• Total: ${s.total} tarjetas (${s.nuevas} nuevas · ${s.aprendiendo} aprendiendo · ${s.dominadas} dominadas)`,
    `• Pendientes hoy: ${s.pendientes_hoy}`,
    `• Difíciles: ${s.dificiles}`,
    `• Aciertos: ${s.aciertos_pct}%`,
    `• Racha: 🔥 ${s.racha} día${s.racha === 1 ? '' : 's'}`,
  ].join('\n')
}

export function formatPending(d: DueStatusResponse): string {
  if (d.pendientes_hoy === 0) return '🎉 No tienes frases pendientes para hoy. ¡Disfruta del día!'
  return `⏰ Tienes ${d.pendientes_hoy} frases pendientes para hoy. ¿Hacemos un repaso rápido? (di 'repaso')`
}

/** Botones inline del repaso (grades SM-2 0/1/3/4/5). */
export function reviewKeyboard(): { inline_keyboard: InlineKeyboardButton[][] } {
  return {
    inline_keyboard: [
      [
        { text: '🙈 No sabía', callback_data: 'grade0' },
        { text: '😓 Difícil', callback_data: 'grade1' },
      ],
      [
        { text: '😐 Normal', callback_data: 'grade3' },
        { text: '😊 Fácil', callback_data: 'grade4' },
        { text: '🔥 Domino', callback_data: 'grade5' },
      ],
    ],
  }
}

/** Paso 1 (Anki): SOLO el front + botón "Ver traducción". */
export function reviewFrontKeyboard(): { inline_keyboard: InlineKeyboardButton[][] } {
  return { inline_keyboard: [[{ text: '👁️ Ver traducción', callback_data: 'ver-traduccion' }]] }
}

/** Paso 2 (Anki): traducción visible + explicación + calificación. */
export function reviewBackKeyboard(): { inline_keyboard: InlineKeyboardButton[][] } {
  return {
    inline_keyboard: [
      [{ text: '📖 Explicación', callback_data: 'explicacion' }],
      [
        { text: '🙈 No sabía', callback_data: 'grade0' },
        { text: '😓 Difícil', callback_data: 'grade1' },
      ],
      [
        { text: '😐 Normal', callback_data: 'grade3' },
        { text: '😊 Fácil', callback_data: 'grade4' },
        { text: '🔥 Domino', callback_data: 'grade5' },
      ],
    ],
  }
}

/** Paso 1: front únicamente. */
export function formatReviewCardFront(card: CardDto): string {
  return `🎴 ${card.front}`
}

/** Paso 2: front + back. */
export function formatReviewCardBack(card: CardDto): string {
  const lines = [`🎴 ${card.front}`, `💬 ${card.back}`]
  if (card.pronunciation) lines.push(`🗣 ${card.pronunciation}`)
  return lines.join('\n')
}

/** Paso 3: front + back + explicación gramatical + ejemplos. */
export function formatReviewCardExplain(card: CardDto): string {
  const lines = [`🎴 ${card.front}`, `💬 ${card.back}`]
  if (card.pronunciation) lines.push(`🗣 ${card.pronunciation}`)
  if (card.explanation) lines.push(`\n📖 ${card.explanation}`)
  let examples: string[] = []
  try {
    examples = JSON.parse(card.examples)
  } catch {
    examples = []
  }
  if (examples.length > 0) {
    lines.push('✨ Ejemplos:')
    for (const ex of examples.slice(0, 3)) lines.push(`• ${ex}`)
  }
  return lines.join('\n')
}

/** Texto de la tarjeta durante el repaso (compatibilidad: fase revelada). */
export function formatReviewCard(card: CardDto): string {
  return formatReviewCardBack(card)
}

export function formatReviewSummary(correct: number, wrong: number, total: number): string {
  return [
    `✅ Sesión completada: ${total} tarjetas · ${correct} bien · ${wrong} falladas.`,
    correct >= wrong ? '¡Sigue así! 🔥' : '¡Mañana lo bordamos! 💪',
  ].join('\n')
}

// ── Evaluación de respuestas libres (sin inventar: palabras clave) ─────────

/**
 * Compara la respuesta libre del usuario con la traducción esperada.
 * Coincidencia de palabras clave normalizadas (sin acentos):
 *  ≥60% → grade 5 (domino), ≥30% → grade 3 (normal), si no grade 1.
 */
export function evaluateAnswer(userText: string, back: string): { grade: number; matched: boolean } {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[¿?¡!.,;:'"()]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 1)
  const userWords = new Set(norm(userText))
  const backWords = norm(back)
  if (backWords.length === 0) return { grade: 3, matched: false }
  const hits = backWords.filter((w) => userWords.has(w)).length
  const ratio = hits / backWords.length
  if (ratio >= 0.6) return { grade: 5, matched: true }
  if (ratio >= 0.3) return { grade: 3, matched: true }
  return { grade: 1, matched: false }
}

// ── Dependencias inyectables ───────────────────────────────────────────────

export interface IntentDeps {
  translate(text: string, opts?: { addCard?: boolean }): Promise<TranslateResponse>
  getReviewQueue(limit?: number): Promise<CardDto[]>
  /** Tarjetas por status ('new' | 'learning' | 'review' | 'mastered' | undefined = todas) — cola de respaldo del repaso infinito. */
  getCards(status?: string, limit?: number): Promise<CardDto[]>
  postReview(cardId: number, grade: number, latencyMs: number): Promise<{ ok: boolean; card: CardDto }>
  getStats(): Promise<StatsResponse>
  getDueStatus(): Promise<DueStatusResponse>
  getStudent(): Promise<StudentResponse>
  updateStudent(patch: Record<string, unknown>): Promise<StudentResponse>
  /** Audio ogg de pronunciación de la tarjeta (para la nota de voz del front). */
  getAudio(cardId: number): Promise<Uint8Array>
  sendMessage(chatId: number | string, text: string, replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] }): Promise<unknown>
}

/** Respuestas de una sola pasada (translate/stats/pending/start/help). */
export async function handleSimpleIntent(
  intent: Intent,
  deps: IntentDeps,
  chatId: number | string
): Promise<string> {
  switch (intent.type) {
    case 'translate': {
      try {
        const t = await deps.translate(intent.text, { addCard: true })
        return formatCardCreated(t)
      } catch (e) {
        return `🚨 No pude traducir: ${(e as Error).message}`
      }
    }
    case 'stats': {
      try {
        return formatStats(await deps.getStats())
      } catch (e) {
        return `🚨 No pude consultar las estadísticas: ${(e as Error).message}`
      }
    }
    case 'pending': {
      try {
        return formatPending(await deps.getDueStatus())
      } catch (e) {
        return `🚨 No pude consultar las pendientes: ${(e as Error).message}`
      }
    }
    case 'start':
      return INTRO_TEXT
    case 'help':
      return HELP_TEXT
    case 'review':
      // El flujo de repaso lo orquesta el poller (sesión multi-mensaje).
      return ''
  }
}
