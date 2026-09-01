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
  /** Cambiar el idioma activo del estudio: 'nl' (holandés) | 'en' (inglés). */
  | { type: 'language'; language: 'nl' | 'en' }
  /** Sin intent determinista: lo resuelve el cerebro de lenguaje natural. */
  | { type: 'chat' }

export const HELP_TEXT = [
  '🎓 Lingua — tu profesor de idiomas (holandés 🇳🇱 e inglés 🇬🇧). Comandos:',
  '• "inglés" / "holandés" — cambiar de idioma',
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
  '🎓 ¡Hola! Soy Lingua, tu profesor de idiomas: holandés 🇳🇱 e inglés 🇬🇧.',
  'Puedo traducirte frases, guardarlas en tus tarjetas y hacer repaso contigo cada día.',
  'Di "inglés" o "holandés" para elegir idioma.',
  '¿Por dónde quieres empezar?',
  'Y si algún día quieres ver todo lo que sé hacer, solo dime "ayuda".',
].join('\n')

/** Confirmación al cambiar el idioma activo del estudio. */
export function formatLanguageSwitch(language: 'nl' | 'en'): string {
  return language === 'en'
    ? "🇬🇧 ¡A estudiar inglés! Di '¿cómo se dice…?' o 'repaso'"
    : "🇳🇱 ¡A estudiar holandés! Di '¿cómo se dice…?' o 'repaso'"
}

/**
 * Respuesta por defecto cuando el mensaje es ambiguo o Lingua no entiende:
 * UNA pregunta breve y amable en lenguaje natural. NUNCA una lista de
 * comandos (esa solo sale si el usuario pide "ayuda"/"comandos").
 * Se usa como fallback del cerebro NL (si el LLM falla) y como red de
 * seguridad del intent 'chat'.
 */
export const CLARIFICATION_TEXT =
  '🤔 No te he entendido del todo. ¿Me lo dices de otra forma?'

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

/**
 * Pool de frases básicas en INGLÉS: cuando la BD de inglés se queda sin
 * tarjetas durante un repaso, el bot genera una tarjeta nueva con estas
 * frases (vía translate con add_card y language='en').
 */
export const EN_PHRASE_POOL: string[] = [
  'good morning',
  'thank you very much',
  'you are welcome',
  'see you tomorrow',
  'how are you doing',
  'I do not understand',
  'where is the train station',
  'how much does this cost',
  'I would like a coffee, please',
  'a beer, please',
  'the check, please',
  'I love you',
  'what is this',
  'I am learning English',
  'do you speak Spanish',
  'I have a question',
  'can you help me, please',
  'I am sorry',
  'have a nice day',
  'nice to meet you',
]

/** Extrae el texto a traducir tras el prefijo de intent (permite ¿ inicial). */
const TRANSLATE_RE =
  /^¿?\s*(?:aprender\s+(?:esta frase|a decir|la frase)\s*:?\s*|aprender\s*:?\s*|guarda\s+(?:esta\s+)?(?:palabra|frase)\s*:?\s*|guarda\s*:?\s*|quiero aprender a decir\s*:?\s*|c[oó]mo se dice\s*:?\s*|dime c[oó]mo se dice\s*:?\s*)(.+)$/i

/**
 * Cambio de idioma activo: "inglés" / "estudiar inglés" / "cambiar a inglés"
 * → 'en'; "holandés" / "cambiar a holandés" → 'nl'. Se comprueba ANTES que
 * translate para que "aprender inglés" cambie de idioma y no traduzca la
 * palabra. Frases como "¿cómo se dice inglés?" no casan (empiezan por
 * "cómo se dice") y siguen traduciendo la palabra.
 */
const LANGUAGE_INTENT_RE =
  /^(?:quiero\s+)?(?:estudiar|cambiar(?:\s+a)?|aprender|practicar|vamos\s+a\s+(?:estudiar|practicar)|a\s+(?:estudiar|practicar))?\s*(ingl[eé]s|english|holand[eé]s|neerland[eé]s|nederlands)\b/i

export function parseIntent(raw: string): Intent {
  const text = (raw ?? '').trim()
  // Vacío o sin intent determinista → chat (cerebro NL). El menú de comandos
  // SOLO sale si el usuario pide explícitamente "ayuda"/"comandos".
  if (!text) return { type: 'chat' }

  const langMatch = text.match(LANGUAGE_INTENT_RE)
  if (langMatch) {
    const word = langMatch[1].toLowerCase()
    const language: 'nl' | 'en' = /^ingl[eé]s|^english/.test(word) ? 'en' : 'nl'
    return { type: 'language', language }
  }

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
  // Saludo breve y amable; "ayuda"/"comandos" (explícito) → la lista de comandos.
  if (/^(hola|inicio|empezar|buenas|hey|qu[eé] puedes hacer)\b/.test(lower)) {
    return { type: 'start' }
  }
  if (/^(ayuda|help|comandos)\b/.test(lower)) {
    return { type: 'help' }
  }
  // Sin intent determinista: el poller lo deriva al cerebro de lenguaje
  // natural (LLM con el rol de Lingua); si el LLM falla, pregunta en natural.
  return { type: 'chat' }
}

// ── Formato de respuestas ──────────────────────────────────────────────────

export function formatCardCreated(t: TranslateResponse): string {
  const card = t.card
  if (t.duplicate) return 'Ya la tienes 😊'
  // El front es el texto en el idioma objetivo (en o nl); back siempre es el español.
  const front = card?.front ?? t.en ?? t.nl
  const lines = [
    '✅ Perfecto. Te la añado a tus tarjetas:',
    `📌 ${front}`,
    `💬 ${card?.back ?? t.es}`,
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
  /** Cambia el idioma activo del usuario (persistido en data/dutch/user_language.json). */
  setLanguage(chatId: number | string, language: 'nl' | 'en'): void
  /**
   * Cerebro redactor (opcional): cuando el intent devuelve DATOS (traducción,
   * estadísticas, pendientes), el bot construye el contexto real y el LLM
   * redacta la respuesta final en conversación natural. Si no está o falla →
   * plantilla actual (nunca mudo).
   */
  brain?: Brain
}

// ── Redacción con cerebro NL (contexto real → LLM → conversación natural) ──

/** Petición de redacción: el bot construye el contexto real y el LLM redacta. */
export interface RedactRequest {
  /** Qué se responde (traducción / estadísticas / pendientes). */
  kind: string
  /** Texto original del usuario (para responderle conversacional). */
  userText: string
  /** Datos REALES, en texto estructurado. */
  context: string
  /** Plantilla actual: fallback si el LLM falla (nunca mudo). */
  fallback: string
}

/** Redactor del cerebro NL inyectable (el poller lo conecta al api_server). */
export type Brain = (req: RedactRequest) => Promise<{ response: string; brain: 'nl' | 'fallback' }>

/**
 * Pasa la redacción al cerebro NL; si no hay cerebro o el LLM falla
 * (402/timeout/red), devuelve la plantilla actual. Nunca lanza, nunca mudo.
 */
export async function redactOrFallback(brain: Brain | undefined, req: RedactRequest): Promise<string> {
  if (!brain) return req.fallback
  try {
    const out = await brain(req)
    if (out.brain === 'nl' && typeof out.response === 'string' && out.response.trim()) {
      return out.response
    }
    return req.fallback
  } catch (e) {
    console.error(`intents: cerebro NL no redactó (${(e as Error).message}) — plantilla`)
    return req.fallback
  }
}

// ── Contextos reales para el cerebro NL ────────────────────────────────────

/** Contexto de una traducción/tarjeta (los datos reales de la respuesta). */
export function buildTranslateContext(t: TranslateResponse): string {
  const lang = t.language ?? (t.en ? 'en' : 'nl')
  const front = t.en || t.nl
  const lines = [`${lang}: ${front}`, `es: ${t.es}`]
  if (t.pronunciation) lines.push(`pronunciacion: ${t.pronunciation}`)
  if (t.explanation) lines.push(`explicacion: ${t.explanation}`)
  if (t.examples && t.examples.length > 0) lines.push(`ejemplos: ${t.examples.slice(0, 3).join(' | ')}`)
  lines.push(t.duplicate ? '(ya existía en tus tarjetas)' : '(tarjeta nueva añadida a tu colección)')
  return lines.join('\n')
}

/** Contexto de las estadísticas de aprendizaje. */
export function buildStatsContext(s: StatsResponse): string {
  return [
    `total: ${s.total}`,
    `nuevas: ${s.nuevas}`,
    `aprendiendo: ${s.aprendiendo}`,
    `dominadas: ${s.dominadas}`,
    `pendientes_hoy: ${s.pendientes_hoy}`,
    `dificiles: ${s.dificiles}`,
    `aciertos_pct: ${s.aciertos_pct}%`,
    `racha_dias: ${s.racha}`,
  ].join('\n')
}

/** Contexto de las pendientes de hoy. */
export function buildPendingContext(d: DueStatusResponse): string {
  return [
    `pendientes_hoy: ${d.pendientes_hoy}`,
    `nuevas_disponibles: ${d.nuevas_disponibles}`,
    `dificiles: ${d.dificiles}`,
  ].join('\n')
}

/** Respuestas de una sola pasada (translate/stats/pending/start/help). */
export async function handleSimpleIntent(
  intent: Intent,
  deps: IntentDeps,
  chatId: number | string,
  userText = ''
): Promise<string> {
  switch (intent.type) {
    case 'translate': {
      try {
        const t = await deps.translate(intent.text, { addCard: true })
        return redactOrFallback(deps.brain, {
          kind: 'traducción y tarjeta nueva',
          userText,
          context: buildTranslateContext(t),
          fallback: formatCardCreated(t),
        })
      } catch (e) {
        return `🚨 No pude traducir: ${(e as Error).message}`
      }
    }
    case 'stats': {
      try {
        const s = await deps.getStats()
        return redactOrFallback(deps.brain, {
          kind: 'estadísticas de aprendizaje',
          userText,
          context: buildStatsContext(s),
          fallback: formatStats(s),
        })
      } catch (e) {
        return `🚨 No pude consultar las estadísticas: ${(e as Error).message}`
      }
    }
    case 'pending': {
      try {
        const d = await deps.getDueStatus()
        return redactOrFallback(deps.brain, {
          kind: 'frases pendientes para hoy',
          userText,
          context: buildPendingContext(d),
          fallback: formatPending(d),
        })
      } catch (e) {
        return `🚨 No pude consultar las pendientes: ${(e as Error).message}`
      }
    }
    case 'start':
      return INTRO_TEXT
    case 'help':
      return HELP_TEXT
    case 'language': {
      // Cambia el idioma activo (persistido) y confirma con el mensaje.
      deps.setLanguage(chatId, intent.language)
      return formatLanguageSwitch(intent.language)
    }
    case 'review':
      // El flujo de repaso lo orquesta el poller (sesión multi-mensaje).
      return ''
    case 'chat':
      // El poller lo resuelve con el cerebro de lenguaje natural antes de
      // llegar aquí; este caso es solo una red de seguridad.
      return ''
  }
}
