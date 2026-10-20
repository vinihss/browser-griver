import { test } from "node:test"
import assert from "node:assert/strict"
import { runRecipe } from "../src/runtime/index.js"
import type { Expect, ExtractAttr, TargetRef } from "../src/runtime/index.js"

/** Driver de mentira: guarda o que recebeu, não faz nada. */
function driverDeMentira() {
  const asserts: { target: TargetRef | undefined; expect: Expect }[] = []
  const preenchidos: { value: string }[] = []
  const selecionados: { value: string }[] = []

  return {
    asserts,
    preenchidos,
    selecionados,
    driver: {
      target: "browser" as const,
      async navigate() {},
      async click() {},
      async fill(_target: TargetRef, value: string) {
        preenchidos.push({ value })
      },
      async press() {},
      async select(_target: TargetRef, value: string) {
        selecionados.push({ value })
      },
      async hover() {},
      async scrollTo() {},
      async upload() {},
      async wait() {},
      async waitFor() {},
      async extract(_target: TargetRef, attr: ExtractAttr | undefined, many: boolean) {
        return { value: many ? ["a", "b"] : "Olá Vinicius, plano pro", count: 1 }
      },
      async assert(target: TargetRef | undefined, expect: Expect) {
        asserts.push({ target, expect })
      },
      async eval() {
        return undefined
      },
      async screenshot() {
        return {}
      },
      async currentUrl() {
        return "http://exemplo.test/"
      },
      async close() {},
    },
  }
}

test("o valor esperado da verificação usa as variáveis da execução", async () => {
  const { asserts, driver } = driverDeMentira()

  const resultado = await runRecipe(
    {
      version: 1,
      steps: [
        { id: "e", type: "extract", target: { selectors: ["#resultado"] }, attr: "text", saveAs: "resultado" },
        { id: "a", type: "assert", target: { selectors: ["#resultado"] }, expect: { kind: "contains", value: "plano {{plano}}" } },
      ],
    },
    driver,
    { scope: { plano: "pro" } },
  )

  assert.equal(resultado.status, "ok")
  assert.equal(asserts.length, 1)
  assert.equal(asserts[0]!.expect.value, "plano pro", "o esperado é montado com o que a execução sabe")
})

test("o valor esperado sem variável fica como está", async () => {
  const { asserts, driver } = driverDeMentira()

  const resultado = await runRecipe(
    {
      version: 1,
      steps: [
        { id: "a", type: "assert", target: { selectors: ["#resultado"] }, expect: { kind: "contains", value: "plano pro" } },
      ],
    },
    driver,
  )

  assert.equal(resultado.status, "ok")
  assert.equal(asserts[0]!.expect.value, "plano pro")
})

test("a verificação sem valor esperado não inventa um", async () => {
  const { asserts, driver } = driverDeMentira()

  const resultado = await runRecipe(
    {
      version: 1,
      steps: [{ id: "a", type: "assert", target: { selectors: ["#resultado"] }, expect: { kind: "visible" } }],
    },
    driver,
  )

  assert.equal(resultado.status, "ok")
  assert.equal(asserts[0]!.expect.value, undefined)
})
