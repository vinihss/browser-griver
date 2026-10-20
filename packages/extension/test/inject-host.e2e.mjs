/**
 * Confere a permissão de host: o service worker precisa poder injetar o
 * content script em qualquer página, inclusive nas que já estavam abertas
 * antes da extensão ser carregada.
 *
 * Usa `[::1]` de propósito: não é 127.0.0.1 nem localhost, então só funciona
 * com host_permissions amplo.
 */
import { chromium } from "playwright"
import { createServer } from "node:http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXTENSION_PATH, fecharAoFalhar } from "./helpers.mjs"

const extensionPath = EXTENSION_PATH

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end("<!doctype html><title>Teste</title><button id='b'>Botão</button>")
})
// porta efêmera: duas suítes rodando ao mesmo tempo não disputam a 8099
await new Promise((resolve_) => server.listen(0, "::1", () => resolve_()))
const { port } = server.address()

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "griver-perm-")), {
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
  ],
})

fecharAoFalhar(context)

let worker = context.serviceWorkers()[0]
if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 })

const page = await context.newPage()
await page.goto(`http://[::1]:${port}/`)
await page.waitForTimeout(800)

const resultado = await worker.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return { erro: "sem aba ativa" }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
    const r = await chrome.tabs.sendMessage(tab.id, {
      type: "griver:page",
      command: { action: "context" },
    })
    return { ok: true, titulo: r?.result?.title }
  } catch (error) {
    return { ok: false, erro: String(error) }
  }
})

console.log("injeção em página fora de localhost:", JSON.stringify(resultado))

await context.close()
server.close()
process.exit(resultado.ok ? 0 : 1)
