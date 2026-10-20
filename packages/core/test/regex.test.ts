import { test } from "node:test"
import assert from "node:assert/strict"
import { buildRegExp, compare } from "../src/runtime/vars.js"

test("o padrão aceita flags no começo, como (?i)", () => {
  const regex = buildRegExp("(?i)plano\\s+pro")
  assert.ok(regex, "o padrão deveria compilar")
  assert.equal(regex?.flags, "i")
  assert.equal(regex?.test("Olá Maria, PLANO PRO"), true)
})

test("várias flags no começo valem ao mesmo tempo", () => {
  const regex = buildRegExp("(?is)plano\\s+pro")
  assert.ok(regex)
  assert.equal(regex?.flags, "is")
})

test("padrão sem flags continua funcionando", () => {
  const regex = buildRegExp("plano\\s+pro")
  assert.equal(regex?.flags, "")
  assert.equal(regex?.test("plano pro"), true)
})

test("padrão inválido devolve null em vez de estourar", () => {
  assert.equal(buildRegExp("(plano"), null)
  assert.equal(buildRegExp("(?g)plano"), null)
})

test("compare com matches entende a flag inline", () => {
  assert.equal(compare("Olá Maria, PLANO PRO", "matches", "(?i)plano\\s+pro"), true)
  assert.equal(compare("Olá Maria, plano básico", "matches", "(?i)plano\\s+pro"), false)
})

test("compare com matches de padrão inválido não casa", () => {
  assert.equal(compare("qualquer coisa", "matches", "(plano"), false)
})
