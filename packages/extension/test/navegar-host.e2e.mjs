/**
 * Confere se o service worker consegue navegar uma aba para uma URL externa.
 * Sem permissão de host, o Chrome responde "Navigation rejected.".
 */
import { chromium } from "playwright"
import { createServer } from "node:http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXTENSION_PATH, achaAba, fecharAoFalhar, opcoesDoNavegador } from "./helpers.mjs"

const extensionPath = EXTENSION_PATH

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end("<!doctype html><title>Destino</title><h1 id='ok'>destino</h1>")
})
// porta efêmera: duas suítes rodando ao mesmo tempo não disputam a 8099
await new Promise((resolve_) => server.listen(0, "::1", () => resolve_()))
const { port } = server.address()

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "griver-nav-")), {
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

const page = await context.newPage()
await page.goto(`http://[::1]:${port}/`)
await page.waitForTimeout(600)

// a aba é achada pelo endereço: a aba ativa depende do foco da janela e
// muda quando outro Chrome aparece na tela
const aba = await achaAba(worker, `http://[::1]:${port}`)
if (!aba) {
  console.log(JSON.stringify({ indo: ["aba do teste não encontrada"] }, null, 1))
  await context.close()
  server.close()
  process.exit(1)
}

const resultado = await worker.evaluate(async ([tabId, porta]) => {
  const indo = []
  try {
    await chrome.tabs.update(tabId, { url: `http://[::1]:${porta}/destino` })
    indo.push("destino ok")
  } catch (error) {
    indo.push(`destino falhou: ${error}`)
  }
  try {
    await chrome.tabs.update(tabId, { url: "https://www.example.com/" })
    indo.push("https ok")
  } catch (error) {
    indo.push(`https falhou: ${error}`)
  }
  return { indo }
}, [aba.id, port])

console.log(JSON.stringify(resultado, null, 1))

await context.close()
server.close()

// sem permissão de host o Chrome recusa a navegação: o teste precisa falhar
const navegou = (resultado?.indo?.length ?? 0) === 2 && resultado.indo.every((linha) => !linha.includes("falhou"))
process.exit(navegou ? 0 : 1)
