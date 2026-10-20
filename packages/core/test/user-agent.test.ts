import assert from "node:assert/strict"
import { test } from "node:test"

import { USER_AGENT_REAL, userAgentDe } from "@griver/core"

test("sem tela, o user-agent não se entrega como headless", () => {
  const agente = userAgentDe(false)
  assert.ok(agente)
  assert.ok(!/headless/i.test(agente), `user-agent entrega headless: ${agente}`)
  assert.match(agente, /Chrome\/\d+/)
})

test("com tela, o navegador fala por si", () => {
  // trocar a identidade do Chrome do usuário por uma de mentira não ajuda
  assert.equal(userAgentDe(true), undefined)
})

test("o user-agent padrão é o mesmo em todo lugar", () => {
  assert.equal(userAgentDe(undefined), USER_AGENT_REAL)
})
