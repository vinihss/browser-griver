/** Confere que uma gravação impossível aparece como erro no painel. */
import { chromium } from "playwright"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const extensionPath = resolve("packages/extension/dist")

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "griver-erro-")), {
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
  ],
})

let worker = context.serviceWorkers()[0]
if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 })

const panel = await context.newPage()
await panel.goto(`chrome-extension://${new URL(worker.url()).host}/panel.html`)
await panel.waitForTimeout(800)

// conecta
await panel.evaluate(async () => {
  document.querySelector('.panel-header button[title="Ajustes"]')?.click()
  await new Promise((r) => setTimeout(r, 300))
  Array.from(document.querySelectorAll("button"))
    .find((b) => b.textContent?.includes("Conectar"))
    ?.click()
})
await panel.waitForTimeout(1500)

// com a aba do painel ativa, gravar é impossível: precisa avisar
await panel.evaluate(() => {
  document.querySelector('.panel-header button[title="Receitas"]')?.click()
})
await panel.waitForTimeout(400)
await panel.evaluate(() => {
  Array.from(document.querySelectorAll("button"))
    .find((b) => b.textContent?.trim() === "● Gravar")
    ?.click()
})
await panel.waitForTimeout(1200)

const aviso = await panel.evaluate(() => document.querySelector(".notice")?.textContent?.trim())
console.log("aviso exibido:", JSON.stringify(aviso))

await context.close()
process.exit(aviso?.includes("não pode ser gravada") ? 0 : 1)
