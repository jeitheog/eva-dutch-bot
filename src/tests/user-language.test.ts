/**
 * Tests del idioma activo por usuario (data/dutch/user_language.json):
 * default 'nl', persistencia entre cargas y aislamiento por usuario.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  getUserLanguage,
  setLanguageStoreFileForTests,
  setUserLanguage,
} from '../services/user-language'

function freshStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingua-user-lang-test-'))
  const file = path.join(dir, 'user_language.json')
  setLanguageStoreFileForTests(file)
  return file
}

test('default nl: sin estado previo, cualquier usuario estudia holandés', () => {
  freshStore()
  assert.equal(getUserLanguage(7026212206), 'nl')
  assert.equal(getUserLanguage('7181079278'), 'nl')
})

test('setUserLanguage(' + "'en'" + ') persiste y sobrevive a una recarga (nueva caché)', () => {
  const file = freshStore()
  setUserLanguage(7026212206, 'en')
  assert.equal(getUserLanguage(7026212206), 'en')
  // "Recarga": nueva caché leyendo el archivo.
  setLanguageStoreFileForTests(file)
  assert.equal(getUserLanguage(7026212206), 'en', 'persistido en disco')
})

test('idioma por usuario: cambiar uno no afecta al otro', () => {
  freshStore()
  setUserLanguage(7026212206, 'en')
  assert.equal(getUserLanguage(7026212206), 'en')
  assert.equal(getUserLanguage(7181079278), 'nl')
})

test('valores inválidos en disco → se ignoran (default nl)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingua-user-lang-test-'))
  const file = path.join(dir, 'user_language.json')
  fs.writeFileSync(file, JSON.stringify({ '7026212206': 'fr' }))
  setLanguageStoreFileForTests(file)
  assert.equal(getUserLanguage(7026212206), 'nl')
})
