/**
 * Confere se o service worker consegue navegar uma aba para uma URL externa.
 * Sem permissão de host, o Chrome responde "Navigation rejected.".
 */
import { chromium } from "playwright"
import { createServer } from "node:http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const extensionPath = resolve("packages/extension/dist")

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end("<!doctype html><title>Destino</title><h1 id='ok'>destino</h1>")
})
await new Promise((resolve_) => server.listen(8099, "::1", () => resolve_()))

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "griver-nav-")), {
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
  ],
})

let worker = context.serviceWorkers()[0]
if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 })

const page = await context.newPage()
await page.goto("http://[::1]:8099/")
await page.waitForTimeout(600)

const resultado = await worker.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return { erro: "sem aba" }
  const indo = []
  try {
    await chrome.tabs.update(tab.id, { url: "http://[::1]:8099/destino" })
    indo.push("destino ok")
  } catch (error) {
    indo.push(`destino falhou: ${error}`)
  }
  try {
    await chrome.tabs.update(tab.id, { url: "https://www.example.com/" })
    indo.push("https ok")
  } catch (error) {
    indo.push(`https falhou: ${error}`)
  }
  return { indo }
})

console.log(JSON.stringify(resultado, null, 1))

await context.close()
server.close()
