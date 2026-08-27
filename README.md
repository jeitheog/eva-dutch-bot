# eva-dutch-bot — Lingua 🎓 (el bot de Telegram)

Profesor de holandés por Telegram. Este servicio es el **bot**: polling
propio con el token de Lingua, intents en español, sesiones de repaso con
botones SM-2 (grade0/1/3/4/5), entrevista progresiva y recordatorios cada
4h. Consume la API de eva-dutch-service (puerto 3022).

## Stack

- Node 22+, Express + TypeScript, patrón eva-youtube-bot (poller propio)
- Allowlist: solo **Jei (7026212206)** y **Jessi (7181079278)**; cualquier
  otro remitente se ignora silenciosamente (recordatorios y pings incluidos)
- Estado persistente en `data/dutch/` (offset del polling + último recordatorio)

## Intents (español)

| Frase | Acción |
|---|---|
| `¿cómo se dice X?` / `aprender esta frase: X` / `guarda esta palabra: X` | Traduce (LLM) y crea la tarjeta (sin duplicados) |
| `repaso` / `dame 10 frases` / `examen rápido` / `solo palabras difíciles` | Sesión de repaso estilo Anki: front → 👁️ Ver traducción → 📖 Explicación → calificación (botones) |
| `sigue` / `siguiente` / `siguiente frase` / `otra` | Durante un repaso: salta a la siguiente tarjeta y recarga la cola si se agotó (sin límite de N); sin sesión activa, arranca un repaso |
| `para` / `basta` / `stop` / `termina` | Termina la sesión de repaso con el resumen |
| `estadísticas` | Resumen del progreso |
| `pendientes` | Cuántas frases quedan para hoy |
| `hola` | Presentación + entrevista progresiva (nombre → profesión → hobbies → /student) |
| texto libre durante el repaso | Se evalúa por palabras clave (sin inventar) y se registra el grade |

## Recordatorios

Cada 4h consulta `GET /due/status`; si hay pendientes y no se avisó hoy
(`data/dutch/last_reminder.json`), envía el aviso. Máx 1/día.

## API (auth `x-dutch-bot-api-key`)

- `GET /health`
- `GET /api/v1/dutch-bot/status` — polling + recordatorios
- `POST /api/v1/dutch-bot/ping` — `{chat_id, text}` → envía un mensaje real por el bot

## Desarrollo

```bash
npm ci && npm run build
npm test          # node:test (mocks, sin red)
bash deploy/s6-register.sh   # registro s6 (puerto 3023)
```
