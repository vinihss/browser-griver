/**
 * O passo `screenshot` de uma receita rodando na aba.
 *
 * A captura é a única parte do driver da aba que não é CONTENT_SCRIPT: ela
 * sai do próprio Chrome (`captureVisibleTab`), que exige permissão de host
 * para a aba capturada e a janela certa. Nenhum outro teste cobre esse
 * caminho — a receita falhava no último passo, depois de tudo dar certo, e o
 * erro ("No window with id", "Either the '<all_urls>' or 'activeTab'
 * permission is required") não dizia o que tinha dado errado.
 *
 * O teste sobe o seu próprio Chrome com a extensão e roda uma receita com um
 * passo de captura, pela API do servidor, como o usuário roda.
 */
import { chromium } from "playwright"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXTENSION_PATH, apontaParaServidor, fecharAoFalhar, servidorDoTeste } from "./helpers.mjs"

const extensionPath = EXTENSION_PATH
const serverUrl = servidorDoTeste(process.argv.slice(2))
const targetUrl = process.argv[3] ?? "file:///tmp/opencode/teste.html"

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "griver-print-")), {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
  ],
})

fecharAoFalhar(context)

let worker = context.serviceWorkers()[0]
if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 })

// a extensão aponta para o servidor do teste antes de qualquer conversa
await apontaParaServidor(worker, serverUrl)

// a aba do teste fica na frente: a captura sai da aba visível da janela
const page = await context.newPage()
await page.goto(targetUrl)
await page.waitForTimeout(500)
await page.bringToFront()

// ── a semente: um projeto e uma receita com um passo de captura ──────────
const { token } = await fetch(`${serverUrl}/api/extension-token`).then((r) => r.json())
const headers = { "content-type": "application/json", "x-griver-token": token }

const projeto = await fetch(`${serverUrl}/api/projects`, {
  method: "POST",
  headers,
  body: JSON.stringify({ name: "Teste print" }),
}).then((r) => r.json())

const receita = await fetch(`${serverUrl}/api/recipes`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    projectId: projeto.project.id,
    name: "Captura",
    target: "browser",
    recipe: {
      version: 1,
      steps: [
        { id: "n1", type: "navigate", url: targetUrl },
        { id: "f1", type: "fill", target: { selectors: ["#nome"] }, value: "Maria" },
        { id: "ss1", type: "screenshot", saveAs: "print-formulario" },
      ],
    },
  }),
}).then((r) => r.json())

// ── a execução: a receita roda na aba, pelo driver da extensão ───────────
const { runId } = await fetch(`${serverUrl}/api/runs`, {
  method: "POST",
  headers,
  body: JSON.stringify({ recipeId: receita.recipe.id, driver: "tab" }),
}).then((r) => r.json())

// a execução só acaba quando a extensão termina: o registro no servidor é a
// única fonte da verdade
let ultimo = null
for (let tentativa = 0; tentativa < 60; tentativa++) {
  await new Promise((r) => setTimeout(r, 500))
  const resposta = await fetch(`${serverUrl}/api/runs/${runId}`, { headers })
  if (!resposta.ok) continue
  const dados = await resposta.json()
  ultimo = dados.run
  if (ultimo && ultimo.status !== "running") break
}

const print = ultimo?.scope?.["print-formulario"]
const tamanho = typeof print === "string" ? print.length : 0

console.log("1. execução:", ultimo?.status ?? "nenhuma", "| erro:", ultimo?.error ?? "nenhum")
console.log("2. print no escopo:", tamanho > 0 ? `sim (${tamanho} caracteres)` : "não")

// limpeza: o teste já tem o que verificar
await fetch(`${serverUrl}/api/projects/${projeto.project.id}`, { method: "DELETE", headers }).catch(
  () => {},
)
await context.close()

const capturou = ultimo?.status === "ok" && tamanho > 0
console.log(`\ncaptura: ${capturou ? "ok" : "FALHOU"}`)

process.exit(capturou ? 0 : 1)
