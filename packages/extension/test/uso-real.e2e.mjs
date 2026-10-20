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
import { EXTENSION_PATH, apontaParaServidor, conectar, fecharAoFalhar, opcoesDoNavegador, servidorDoTeste } from "./helpers.mjs"

const extensionPath = EXTENSION_PATH
const serverUrl = servidorDoTeste(process.argv.slice(2))
const targetUrl = process.argv[3] ?? "file:///tmp/opencode/teste.html"

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "griver-uso-")), {
  ...opcoesDoNavegador(),
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

// a extensão nasce conectada ao servidor padrão: é preciso reconectar para
// que ela aponte para o servidor do teste e renove o token
const online = await conectar(panel, serverUrl)
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

// a lista do painel só recebe a receita nova quando o servidor avisa que
// ela mudou. Sem esperar, o clique cai na receita que já estava na lista —
// e o teste passa a rodar o passo errado sem perceber
let naLista = false
for (let tentativa = 0; tentativa < 20 && !naLista; tentativa++) {
  await panel.waitForTimeout(500)
  naLista = await panel.evaluate(() =>
    Array.from(document.querySelectorAll(".recipe-row .truncate")).some(
      (b) => b.textContent?.trim() === "Fluxo",
    ),
  )
}
console.log("2. receita nova na lista do painel:", naLista ? "sim" : "NÃO")

// executa pela UI, como o usuário faz
await panel.evaluate(async () => {
  document.querySelector('.panel-header button[title="Receitas"]')?.click()
  await new Promise((r) => setTimeout(r, 600))
  // seleciona a receita na lista
  const alvo = Array.from(document.querySelectorAll(".recipe-row .truncate")).find(
    (b) => b.textContent?.trim() === "Fluxo",
  )
  alvo?.parentElement?.click()
})
// o editor abre depois do clique: sem esperar, o botão ainda não existe
await panel.waitForTimeout(1000)

const disparou = await panel.evaluate(() => {
  const botao = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Executar aqui",
  )
  if (!botao) return false
  botao.click()
  return true
})
console.log("3. execução disparada:", disparou ? "sim" : "NÃO")

// espera a execução acabar: o que vale é o registro no servidor, não o
// texto da página (que já pode ter o conteúdo de outra execução)
let ultimo = null
for (let i = 0; i < 40; i++) {
  await panel.waitForTimeout(500)
  const runs = (await api("/api/runs")).body.runs ?? []
  ultimo = runs.find((r) => r.recipeId === receita.id) ?? null
  if (ultimo && ultimo.status !== "running") break
}

const resultado = await page
  .evaluate(() => document.querySelector("#resultado")?.textContent ?? "")
  .catch(() => "")

console.log("4. execução:", ultimo?.status ?? "nenhuma", "| erro:", ultimo?.error ?? "nenhum")
console.log("   resultado na página:", JSON.stringify(resultado))

// ── 3. primeira mensagem do chat ──────────────────────────────────────────
//
// O chat depende do OpenCode local. Sem ele no ar, o servidor cria a
// sessão sem `opencodeSessionId` e a mensagem não sai — o teste reprovaria
// por uma dependência que não é dele. Aí a parte é pulada, e o teste diz
// que pulou, em vez de fingir que o chat funcionou.
const sessao = await api("/api/chat/sessions", { method: "POST", body: JSON.stringify({}) })
const temOpenCode = Boolean(sessao.body?.session?.opencodeSessionId)

let bolhas = []
let enviou = false
let respondeu = false

if (!temOpenCode) {
  console.log("5. mensagens no chat: pulado — o OpenCode local não está no ar")
} else {
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
  for (let tentativa = 0; tentativa < 60; tentativa++) {
    await panel.waitForTimeout(1000)
    bolhas = await panel.evaluate(() =>
      Array.from(document.querySelectorAll(".chat-msg")).map((b) => b.textContent?.trim()),
    )
    if (bolhas.some((b) => b?.includes("próximo passo"))) break
  }
  console.log("5. mensagens no chat:", JSON.stringify(bolhas.slice(0, 4)))

  enviou = bolhas.some((b) => b?.includes("próximo passo"))
  respondeu = bolhas.some((b) => b?.includes("assistente") || b?.includes("sistema"))
}

// limpeza: falhar aqui não deve derrubar o teste, que já tem o que verifica
await api(`/api/projects/${projeto.id}`, { method: "DELETE" }).catch((error) => {
  console.log("   (limpeza ignorada:", error.message, ")")
})
await context.close()

console.log(`\nreceitas: ${naLista ? "ok" : "FALHOU"}`)
console.log(`execução: ${ultimo?.status === "ok" ? "ok" : "FALHOU"}`)
console.log(
  `chat: ${
    !temOpenCode
      ? "pulado (sem OpenCode local)"
      : `${enviou ? "mensagem não se perdeu" : "FALHOU"} / ${respondeu ? "respondeu" : "sem resposta (verifique o OpenCode)"}`
  }`,
)

process.exit(naLista && ultimo?.status === "ok" && (enviou || !temOpenCode) ? 0 : 1)
