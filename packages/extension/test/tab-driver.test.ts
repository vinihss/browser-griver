/**
 * A aba que navega no meio de um passo.
 *
 * Quando a página muda com o passo no ar, o documento antigo morre junto com
 * o content script e a resposta nunca chega. O Chrome avisa isso com uma
 * mensagem de canal fechado — e, sem tratamento, a execução inteira quebra
 * num passo que, na verdade, deu certo.
 *
 * Aqui o `chrome` é de mentira: ele responde o que o teste mandar. O que
 * importa é a decisão do driver — repetir a observação no documento novo,
 * ou considerar a escrita feita.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { TabDriver } from "../src/background/tab-driver.js"

const CANAL_FECHADO =
  "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received."

/** Uma aba falsa: responde por tipo de comando e conta as chamadas. */
function abaFalsa(opcoes: {
  /** Documento que a aba tem agora; muda quando a página navega. */
  documento: () => string
  /** O que acontece com um passo `execute`. */
  execute: (tentativa: number) => Promise<unknown>
}) {
  const chamadas = { documento: 0, execute: 0 }

  const chrome = {
    tabs: {
      sendMessage: async (_tabId: number, mensagem: { type: string; command?: { action?: string; step?: { type?: string } } }) => {
        const comando = mensagem.command ?? {}
        if (comando.action === "documento") {
          chamadas.documento++
          return { ok: true, result: { documento: opcoes.documento() } }
        }
        if (comando.action === "context") return { ok: true, result: { documento: opcoes.documento() } }
        chamadas.execute++
        return await opcoes.execute(chamadas.execute)
      },
      get: async () => ({ url: "http://exemplo.test/", status: "complete" }),
      update: async () => undefined,
    },
    scripting: {
      executeScript: async () => undefined,
    },
  }

  ;(globalThis as unknown as { chrome: unknown }).chrome = chrome
  return chamadas
}

test("passo de observação repete no documento novo depois da navegação", async () => {
  let documento = "antigo"
  const chamadas = abaFalsa({
    documento: () => documento,
    execute: async (tentativa) => {
      if (tentativa === 1) {
        // a página navegou com o passo no ar
        documento = "novo"
        throw new Error(CANAL_FECHADO)
      }
      return { ok: true, result: "observado" }
    },
  })

  const driver = new TabDriver(1)
  await driver.waitFor({ selectors: ["#campo"] }, "hidden", 5000)

  assert.equal(chamadas.execute, 2, "o passo deve ser observado de novo na página nova")
})

test("passo de escrita não é repetido quando a página navegou", async () => {
  let documento = "antigo"
  const chamadas = abaFalsa({
    documento: () => documento,
    execute: async () => {
      documento = "novo"
      throw new Error(CANAL_FECHADO)
    },
  })

  const driver = new TabDriver(1)
  await driver.click({ selectors: ["#enviar"] })

  assert.equal(chamadas.execute, 1, "um clique não pode virar dois cliques")
})

test("erro que não é de navegação continua fatal", async () => {
  abaFalsa({
    documento: () => "atual",
    execute: async () => {
      throw new Error("nenhum seletor casou com o elemento")
    },
  })

  const driver = new TabDriver(1)
  await assert.rejects(() => driver.fill({ selectors: ["#campo"] }, "valor"), /nenhum seletor casou/)
})
