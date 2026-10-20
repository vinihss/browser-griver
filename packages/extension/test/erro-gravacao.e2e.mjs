/** Confere que uma gravação impossível aparece como erro no painel. */
import { chromium } from "playwright"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXTENSION_PATH, apontaParaServidor, fecharAoFalhar, opcoesDoNavegador, servidorDoTeste } from "./helpers.mjs"

const extensionPath = EXTENSION_PATH
const serverUrl = servidorDoTeste(process.argv.slice(2))

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "griver-erro-")), {
  ...opcoesDoNavegador(),
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
  ],
})

fecharAoFalhar(context)

let worker = context.serviceWorkers()[0]
if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 })

// o endereço do servidor é gravado antes do painel abrir: senão ele nasce
// apontando para o servidor padrão e erra o endereço
await apontaParaServidor(worker, serverUrl)

const panel = await context.newPage()
await panel.goto(`chrome-extension://${new URL(worker.url()).host}/panel.html`)
// o painel é um módulo: espera o header existir antes de clicar, senão o
// `?.click()` vira no-op e o teste falha sem dizer por quê
await panel.waitForSelector(".panel-header", { timeout: 15000 })
await panel.waitForTimeout(500)

// conecta
await panel.evaluate(async () => {
  document.querySelector('.panel-header button[title="Ajustes"]')?.click()
  await new Promise((r) => setTimeout(r, 300))
  Array.from(document.querySelectorAll("button"))
    .find((b) => b.textContent?.includes("Conectar"))
    ?.click()
})
await panel.waitForTimeout(1500)

// a tela de edição: é ela que traz o "● Gravar"
await panel.evaluate(() => {
  document.querySelector('.panel-header button[title="Receitas"]')?.click()
})
await panel.waitForTimeout(400)
await panel.evaluate(() => {
  document
    .querySelector(
      '.panel-header button[title="Add New Script"], .panel-header button[aria-label="Add New Script"]',
    )
    ?.click()
})
await panel.waitForTimeout(600)

// sem aba de página aberta, gravar é impossível: precisa avisar
await panel.evaluate(() => {
  Array.from(document.querySelectorAll(".view button"))
    .find((b) => b.textContent?.trim() === "● Gravar")
    ?.click()
})
await panel.waitForTimeout(1200)

const aviso = await panel.evaluate(() => document.querySelector(".notice")?.textContent?.trim())
console.log("aviso exibido:", JSON.stringify(aviso))

await context.close()
process.exit(aviso?.includes("nenhuma aba de página") ? 0 : 1)
