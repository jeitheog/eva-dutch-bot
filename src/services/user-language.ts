/**
 * Idioma activo por usuario de Lingua: chat_id → 'nl' | 'en', persistido en
 * data/dutch/user_language.json. Default 'nl' (no rompe el flujo actual).
 * Caché en memoria + escritura atómica sobre el archivo JSON.
 */

import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config'

export type Language = 'nl' | 'en'

let langFile = path.join(config.dataDir, 'user_language.json')
let cache: Record<string, Language> | null = null

function load(): Record<string, Language> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(fs.readFileSync(langFile, 'utf-8'))
    cache = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, Language>) : {}
  } catch {
    cache = {}
  }
  return cache
}

function save(): void {
  try {
    fs.mkdirSync(path.dirname(langFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(langFile, JSON.stringify(cache, null, 2))
  } catch {
    /* si no se puede persistir, el idioma sigue en memoria */
  }
}

/** Idioma activo del usuario (default 'nl'). */
export function getUserLanguage(chatId: number | string): Language {
  const lang = load()[String(chatId)]
  return lang === 'en' ? 'en' : 'nl'
}

/** Cambia el idioma activo del usuario y lo persiste. */
export function setUserLanguage(chatId: number | string, lang: Language): void {
  load()[String(chatId)] = lang === 'en' ? 'en' : 'nl'
  save()
}

/** Resetea la caché y apunta a otro archivo (solo tests). */
export function setLanguageStoreFileForTests(file: string): void {
  langFile = file
  cache = null
}
