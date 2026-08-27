/**
 * Recordatorios automáticos de Lingua: cada 4h consulta /due/status del
 * servicio y, si hay pendientes, envía un aviso — máx 1 por día (persistido
 * en data/dutch/last_reminder.json).
 */

import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config'
import type { DueStatusResponse } from './dutch'

export interface ReminderState {
  running: boolean
  last_reminder_day: string | null
  last_error: string | null
  last_check: string | null
}

export const reminderState: ReminderState = {
  running: false,
  last_reminder_day: null,
  last_error: null,
  last_check: null,
}

const reminderFile = path.join(config.dataDir, 'last_reminder.json')

export function loadLastReminderDay(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(reminderFile, 'utf-8'))
    return typeof parsed.day === 'string' ? parsed.day : null
  } catch {
    return null
  }
}

export function saveLastReminderDay(day: string): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(reminderFile, JSON.stringify({ day, saved_at: new Date().toISOString() }))
  } catch {
    /* si no se puede persistir, seguimos en memoria */
  }
}

export const todayKey = () => new Date().toISOString().slice(0, 10)

export async function checkReminder(deps: {
  getDueStatus(): Promise<DueStatusResponse>
  sendMessage(chatId: number | string, text: string): Promise<unknown>
}): Promise<void> {
  reminderState.last_check = new Date().toISOString()
  try {
    const due = await deps.getDueStatus()
    if (due.pendientes_hoy > 0) {
      const today = todayKey()
      const last = reminderState.last_reminder_day ?? loadLastReminderDay()
      if (last !== today) {
        await deps.sendMessage(
          config.reminderChatId,
          `⏰ Tienes ${due.pendientes_hoy} frases pendientes para hoy. ¿Hacemos un repaso rápido? (di 'repaso')`
        )
        reminderState.last_reminder_day = today
        saveLastReminderDay(today)
        console.log(`dutch-reminder: aviso enviado (${due.pendientes_hoy} pendientes)`)
      }
    }
    reminderState.last_error = null
  } catch (e) {
    reminderState.last_error = (e as Error).message
  }
}

export function startReminder(deps: {
  getDueStatus(): Promise<DueStatusResponse>
  sendMessage(chatId: number | string, text: string): Promise<unknown>
}): NodeJS.Timeout {
  reminderState.running = true
  // Primer check a los 30s del arranque (deja que el servicio esté listo).
  setTimeout(() => checkReminder(deps).catch(() => undefined), 30_000)
  const id = setInterval(() => checkReminder(deps).catch(() => undefined), config.reminderIntervalMs)
  return id
}
