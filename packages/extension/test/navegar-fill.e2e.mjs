/**
 * O preenchimento não pode se perder na navegação.
 *
 * A receita navega para uma página lenta e preenche o campo logo em seguida.
 * O documento antigo ainda está de pé enquanto o novo não chega: se o passo
 * seguinte rodar nele, o valor escrito morre com a navegação e o resultado
 * sai sem o nome — sem erro nenhum, o que é pior.
 *
 * A página lenta é a armadilha: com uma página rápida a corrida quase nunca
 * aparece.
 */
import { chromium } from "playwright"
import { createServer } from "node:http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXTENSION_PATH, fecharAoFalhar, opcoesDoNavegador, servidorDoTeste } from "./helpers.mjs"

/** Quanto a página lenta demora para responder. */
const ATRASO_MS = 1200

const PAGINA = `<!doctype html>
<html lang="pt-BR">
  <head><meta charset="utf-8" /><title>Formulário</title></head>
  <body>
    <form id="form">
      <label for="nome">Nome</label>
      <input id="nome" name="nome" data-testid="campo-nome" />
      <label for="plano">Plano</label>
      <select id="plano"><option value="basico">Básico</option><option value="pro">Pro</option></select>
      <button id="enviar" type="button" data-testid="botao-enviar">Enviar</button>
    </form>
    <p id="resultado" class="preco" hidden></p>
    <script>
      document.getElementById("enviar").addEventListener("click", () => {
        const nome = document.getElementById("nome").value
        const plano = document.getElementById("plano").value
        const saida = document.getElementById("resultado")
        saida.textContent = "Olá " + nome + ", plano " + plano
        saida.hidden = false
      })
    </script>
  </body>
</html>`

const servidor = createServer((req, res) => {
  if (req.url?.startsWith("/lento")) {
    // a página demora: o documento antigo continua de pé durante a navegação
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(PAGINA)
    }, ATRASO_MS)
    return
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(PAGINA)
})
await new Promise((resolve) => servidor.listen(0, "127.0.0.1", resolve))
const { port } = servidor.address()
const base = `http://127.0.0.1:${port}`

const serverUrl = servidorDoTeste(process.argv.slice(2))
const token = await fetch(`${serverUrl}/api/extension-token`).then((r) => r.json())
const cabecalhos = { "content-type": "application/json", "x-griver-token": token.token }
const api = async (caminho, init) =>
  await fetch(`${serverUrl}${caminho}`, { ...(init ?? {}), headers: cabecalhos }).then((r) => r.json())

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "griver-nav-fill-")), {
  ...opcoesDoNavegador(),
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    "--no-first-run",
  ],
})

fecharAoFalhar(context)

let worker = context.serviceWorkers()[0]
if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 })

// a extensão se conecta ao servidor do teste pelo service worker: o painel
// só existe para mandar a mensagem
const painel = await context.newPage()
await painel.goto(`chrome-extension://${new URL(worker.url()).host}/panel.html`)
await painel.waitForSelector(".panel-header", { timeout: 15000 })
await painel.evaluate(async ([url]) => {
  await chrome.runtime.sendMessage({ type: "panel:connect", url, token: "" })
}, [serverUrl])

// o servidor só registra a extensão quando o WebSocket sobe
let online = false
for (let tentativa = 0; tentativa < 40 && !online; tentativa++) {
  await painel.waitForTimeout(250)
  const saude = await fetch(`${serverUrl}/api/health`).then((r) => r.json())
  online = (saude.extensions ?? 0) > 0
}
console.log("0. extensão conectada:", online ? "sim" : "NÃO")
if (!online) {
  await context.close()
  servidor.close()
  process.exit(1)
}

// a aba começa na página rápida: é ela que está de pé quando a navegação
// começa, e é nela que o preenchimento pode se perder
const page = await context.newPage()
await page.goto(`${base}/`)
await page.waitForTimeout(600)

const projeto = (await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Teste navegação" }) }))
  .project
const receita = (
  await api("/api/recipes", {
    method: "POST",
    body: JSON.stringify({
      projectId: projeto.id,
      name: "Preencher depois de navegar",
      target: "browser",
      recipe: {
        version: 1,
        steps: [
          { id: "n1", type: "navigate", url: `${base}/lento` },
          { id: "f1", type: "fill", target: { selectors: ["#nome"] }, value: "Maria" },
          { id: "s1", type: "select", target: { selectors: ["#plano"] }, value: "pro" },
          { id: "c1", type: "click", target: { selectors: ["#enviar"] } },
          { id: "w1", type: "waitFor", target: { selectors: ["#resultado"] }, state: "visible", timeout: 5000 },
          { id: "e1", type: "extract", target: { selectors: ["#resultado"] }, attr: "text", saveAs: "resultado" },
        ],
      },
    }),
  })
).recipe

await page.bringToFront()

const { runId } = await api("/api/runs", {
  method: "POST",
  body: JSON.stringify({ recipeId: receita.id, driver: "tab" }),
})

let run = null
for (let tentativa = 0; tentativa < 60; tentativa++) {
  await painel.waitForTimeout(500)
  run = (await api(`/api/runs/${runId}`)).run
  if (run && run.status !== "running") break
}

const resultado = run?.scope?.resultado ?? ""
console.log("1. execução:", run?.status ?? "nenhuma", "| erro:", run?.error ?? "nenhum")
console.log("2. resultado:", JSON.stringify(resultado))

await api(`/api/projects/${projeto.id}`, { method: "DELETE" }).catch(() => undefined)
await context.close()
servidor.close()

const perdeu = !resultado.includes("Maria")
console.log(`\npreenchimento: ${perdeu ? "PERDIDO (FALHOU)" : "ok"}`)
process.exit(perdeu ? 1 : 0)
