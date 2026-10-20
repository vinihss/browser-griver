/**
 * Cobre os três relatos do usuário:
 *
 *  1. executar uma receita na aba (navegação + passos);
 *  2. a lista de projetos aparecer sozinha ao abrir o painel;
 *  3. a primeira mensagem do chat não ser engolida pela criação da sessão.
 */
import { chromium } from "playwright"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXTENSION_PATH, apontaParaServidor, fecharAoFalhar } from "./helpers.mjs"

const extensionPath = EXTENSION_PATH
const serverUrl = process.argv[2] ?? "http://127.0.0.1:7331"
const targetUrl = process.argv[3] ?? "file:///tmp/opencode/teste.html"

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "griver-uso-")), {
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

// o endereço do servidor é gravado antes do painel abrir: senão ele nasce
// apontando para o servidor padrão e erra o endereço
await apontaParaServidor(worker, serverUrl)

// a extensão já conecta sozinha; basta apontar o servidor
const panel = await context.newPage()
await panel.goto(`chrome-extension://${new URL(worker.url()).host}/panel.html`)
// o painel é um módulo: espera o header existir antes de conferir a tela
await panel.waitForSelector(".panel-header", { timeout: 15000 })

// espera a extensão conectar sozinha ao servidor
let online = false
for (let tentativa = 0; tentativa < 20 && !online; tentativa++) {
  await panel.waitForTimeout(500)
  online = await panel.evaluate(() => Boolean(document.querySelector(".status-online")))
}
console.log("0. conectado ao servidor:", online ? "sim" : "NÃO")

const token = await panel.evaluate(async () => {
  const guardado = await chrome.storage.local.get("griver.token")
  return guardado["griver.token"] ?? ""
})
const api = async (path, init) =>
  panel.evaluate(
    async ([tk, p, i, base]) => {
      const r = await fetch(`${base}${p}`, {
        ...(i ?? {}),
        headers: { "Content-Type": "application/json", "X-Griver-Token": tk },
      })
      return { status: r.status, body: await r.json().catch(() => null) }
    },
    [token, path, init, serverUrl],
  )

// ── 1. receitas aparecem sozinhas ─────────────────────────────────────────
const anotados = await panel.evaluate(() => document.querySelectorAll(".recipe-row").length)
console.log("1. receitas listadas ao abrir o painel:", anotados)

// ── 2. gravar e executar ──────────────────────────────────────────────────
const projeto = (await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Teste uso" }) }))
  .body.project
await panel.evaluate(async () => {
  await chrome.runtime.sendMessage({ type: "panel:status" })
})
await panel.reload()
await panel.waitForSelector(".panel-header", { timeout: 15000 })
await panel.waitForTimeout(1000)

const page = await context.newPage()
await page.goto(targetUrl)
await page.waitForTimeout(500)

const receita = (
  await api("/api/recipes", {
    method: "POST",
    body: JSON.stringify({
      projectId: projeto.id,
      name: "Fluxo",
      target: "browser",
      recipe: {
        version: 1,
        steps: [
          { id: "n1", type: "navigate", url: targetUrl },
          { id: "f1", type: "fill", target: { selectors: ["#nome"] }, value: "Maria" },
          { id: "s1", type: "select", target: { selectors: ["#plano"] }, value: "pro" },
          { id: "c1", type: "click", target: { selectors: ["#enviar"] } },
        ],
      },
    }),
  })
).body.recipe

await page.bringToFront()
// executa pela UI, como o usuário faz
await panel.evaluate(
  async ([id]) => {
    document.querySelector('.panel-header button[title="Receitas"]')?.click()
    await new Promise((r) => setTimeout(r, 600))
    // seleciona a receita na lista
    const itens = Array.from(document.querySelectorAll(".recipe-row .truncate"))
    const alvo = itens.find((b) => b.textContent?.includes("Fluxo"))
    alvo?.parentElement?.click()
    await new Promise((r) => setTimeout(r, 800))
    Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent?.trim() === "Executar aqui")
      ?.click()
    return id
  },
  [receita.id],
)

let resultado = ""
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500))
  resultado = await page.evaluate(() => document.querySelector("#resultado")?.textContent ?? "").catch(() => "")
  if (resultado) break
}

const runs = (await api("/api/runs")).body.runs
const ultimo = runs.find((r) => r.recipeId === receita.id)
console.log("2. execução:", ultimo?.status, "| erro:", ultimo?.error ?? "nenhum")
console.log("   resultado na página:", JSON.stringify(resultado))

// ── 3. primeira mensagem do chat ──────────────────────────────────────────
await panel.bringToFront()
await panel.evaluate(async () => {
  // começa sem sessão, como um painel recém-aberto
  document.querySelector('.panel-header button[title="Chat"]')?.click()
  await new Promise((r) => setTimeout(r, 400))
  const campo = document.querySelector(".chat-input")
  campo.value = "qual é o próximo passo?"
  campo.dispatchEvent(new Event("input", { bubbles: true }))
  Array.from(document.querySelectorAll("button"))
    .find((b) => b.textContent?.trim() === "Enviar")
    ?.click()
})
// a primeira mensagem cria a sessão no OpenCode: num servidor frio isso leva
// ~10s (descoberta do serviço), então espera a mensagem chegar em vez de
// contar com um prazo fixo
let bolhas = []
for (let tentativa = 0; tentativa < 60; tentativa++) {
  await panel.waitForTimeout(1000)
  bolhas = await panel.evaluate(() =>
    Array.from(document.querySelectorAll(".chat-msg")).map((b) => b.textContent?.trim()),
  )
  if (bolhas.some((b) => b?.includes("próximo passo"))) break
}
console.log("3. mensagens no chat:", JSON.stringify(bolhas.slice(0, 4)))

const enviou = bolhas.some((b) => b?.includes("próximo passo"))
const respondeu = bolhas.some((b) => b?.includes("assistente") || b?.includes("sistema"))

// limpeza: falhar aqui não deve derrubar o teste, que já tem o que verifica
await api(`/api/projects/${projeto.id}`, { method: "DELETE" }).catch((error) => {
  console.log("   (limpeza ignorada:", error.message, ")")
})
await context.close()

console.log(`\nprojetos: ${anotados > 0 ? "ok" : "FALHOU"}`)
console.log(`execução: ${ultimo?.status === "ok" ? "ok" : "FALHOU"}`)
console.log(`chat: ${enviou ? "mensagem não se perdeu" : "FALHOU"} / ${respondeu ? "respondeu" : "sem resposta (verifique o OpenCode)"}`)

process.exit(anotados > 0 && ultimo?.status === "ok" && enviou ? 0 : 1)
