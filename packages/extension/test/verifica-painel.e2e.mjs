/**
 * Verificação do painel da extensão em um Chrome real.
 *
 * Carrega a extensão empacotada, abre o painel e confere:
 *  - o painel renderiza sem erro de runtime (header, ações, avisos);
 *  - as receitas carregam sozinhas ao abrir;
 *  - a linha traz título truncado e os botões de editar/executar;
 *  - o botão "+" abre o modal "Add New Script";
 *  - o Chat alterna com Receitas no mesmo painel.
 *
 * Uso: node packages/extension/test/verifica-painel.e2e.mjs <serverUrl>
 */
import { chromium } from "playwright"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXTENSION_PATH, apontaParaServidor, conectar, fecharAoFalhar, opcoesDoNavegador, servidorDoTeste } from "./helpers.mjs"

const extensionPath = EXTENSION_PATH
const serverUrl = servidorDoTeste(process.argv.slice(2))

const userDataDir = mkdtempSync(join(tmpdir(), "griver-verifica-"))

const context = await chromium.launchPersistentContext(userDataDir, {
  ...opcoesDoNavegador(),
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
})

fecharAoFalhar(context)

const erros = []

let worker = context.serviceWorkers()[0]
if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 })

// o endereço do servidor é gravado antes do painel abrir: senão ele nasce
// apontando para o servidor padrão e erra o endereço
await apontaParaServidor(worker, serverUrl)

const panelUrl = `chrome-extension://${new URL(worker.url()).host}/panel.html`
const panel = await context.newPage()

// qualquer erro de runtime na página do painel é falha do teste
panel.on("pageerror", (error) => erros.push(`pageerror: ${error.message}`))
panel.on("console", (msg) => {
  if (msg.type() === "error") erros.push(`console: ${msg.text()}`)
})

await panel.goto(panelUrl)
// o painel é um módulo: espera o header existir antes de conferir a tela
await panel.waitForSelector(".panel-header", { timeout: 15000 })
await panel.waitForTimeout(800)

// ── 0. conectar ao servidor ────────────────────────────────────────────────
// o endereço vai pelo campo de texto do painel: só assim a extensão
// reconnecta ao servidor certo e renova o token
const online = await conectar(panel, serverUrl)
console.log("0. conectado ao servidor:", online ? "sim" : "NÃO")

// ── 1. o painel renderizou? ────────────────────────────────────────────────
const estrutura = await panel.evaluate(() => ({
  temHeader: Boolean(document.querySelector(".panel-header")),
  temMais: Boolean(
    document.querySelector('.panel-header button[title="Add New Script"], .panel-header button[aria-label="Add New Script"]'),
  ),
  temStatus: document.querySelector(".status")?.textContent?.trim() ?? "",
  temBody: Boolean(document.querySelector(".body")),
  temSecao: document.querySelector(".section-title")?.textContent?.trim() ?? "",
}))
console.log("1. header:", estrutura.temHeader, "| botão +:", estrutura.temMais, "| status:", estrutura.temStatus)
console.log("2. seção:", estrutura.temSecao)

// ── 2. receitas carregam sozinhas? ─────────────────────────────────────────
//
// o servidor pode estar vazio — uma base nova não tem receita nenhuma — e
// aí a lista não teria o que mostrar. O teste cria a sua e confere a linha.
const token = await panel.evaluate(async () => {
  const guardado = await chrome.storage.local.get("griver.token")
  return guardado["griver.token"] ?? ""
})

const criada = await panel.evaluate(async ([tk, base]) => {
  const headers = { "Content-Type": "application/json", "X-Griver-Token": tk }
  const projetoRes = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Projeto do teste" }),
  })
  const projeto = (await projetoRes.json()).project
  const receitaRes = await fetch(`${base}/api/recipes`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      projectId: projeto.id,
      name: "Receita do teste",
      target: "browser",
      recipe: { version: 1, steps: [] },
    }),
  })
  const receita = (await receitaRes.json()).recipe
  return { projetoId: projeto?.id ?? "", receitaId: receita?.id ?? "" }
}, [token, serverUrl])
console.log("3. receita criada no servidor:", criada.receitaId ? "sim" : "NÃO")

await panel.waitForTimeout(1500)
const receitas = await panel.evaluate(() =>
  Array.from(document.querySelectorAll(".recipe-row .truncate")).map(
    (el) => el.textContent?.trim() ?? "",
  ),
)
console.log("4. receitas carregadas automaticamente:", receitas.length ? receitas.join(", ") : "(nenhuma)")

// ── 3. a linha tem os botões de ação? ───────────────────────────────────────
const acoes = await panel.evaluate(() => {
  const row = document.querySelector(".recipe-row")
  if (!row) return { ok: false, motivo: "sem linha" }
  const botoes = Array.from(row.querySelectorAll(".row-actions button")).map((b) => b.title)
  return {
    ok: botoes.includes("Editar") && botoes.includes("Executar"),
    botoes,
    truncado: Boolean(row.querySelector(".truncate")),
  }
})
console.log("5. botões de ação (Edit, Run):", acoes.ok ? "sim" : `NÃO (${JSON.stringify(acoes)})`)
console.log("6. título truncado:", acoes.truncado ? "sim" : "NÃO")

// ── 4. o "+" abre o modal Add New Script? ───────────────────────────────────
await panel.evaluate(() => {
  const botao = document.querySelector(
    '.panel-header button[title="Add New Script"], .panel-header button[aria-label="Add New Script"]',
  )
  botao?.click()
})
await panel.waitForTimeout(500)

const modal = await panel.evaluate(() => {
  const el = document.querySelector(".modal")
  if (!el) return { ok: false, motivo: "sem modal" }
  const labels = Array.from(el.querySelectorAll(".field-label")).map((l) => l.textContent?.trim())
  const botoes = Array.from(el.querySelectorAll("button")).map((b) => b.textContent?.trim())
  return { ok: true, labels, botoes }
})
console.log("7. modal Add New Script:", modal.ok ? `sim (${modal.labels.join(", ")} | ${modal.botoes.join(", ")})` : "NÃO")

// fecha o modal
await panel.evaluate(() => {
  const botao = Array.from(document.querySelectorAll(".modal button")).find(
    (b) => b.textContent?.trim() === "Cancel",
  )
  botao?.click()
})
await panel.waitForTimeout(300)

// ── 5. o Chat alterna com Receitas? ─────────────────────────────────────────
await panel.evaluate(() => {
  const botao = document.querySelector('.panel-header button[title="Chat"]')
  botao?.click()
})
await panel.waitForTimeout(600)

const chat = await panel.evaluate(() => ({
  temConversa: Boolean(document.querySelector(".chat-messages")),
  temReceitas: Boolean(document.querySelector(".recipe-row")),
}))
console.log("8. Chat alternado:", chat.temConversa && !chat.temReceitas ? "sim" : `NÃO (${JSON.stringify(chat)})`)

// volta para Receitas
await panel.evaluate(() => {
  const botao = document.querySelector('.panel-header button[title="Receitas"]')
  botao?.click()
})
await panel.waitForTimeout(500)

const voltou = await panel.evaluate(() => Boolean(document.querySelector(".recipe-row")))
console.log("9. voltou para Receitas:", voltou ? "sim" : "NÃO")

// ── 6. erros de runtime ────────────────────────────────────────────────────
console.log("\nerros de runtime:", erros.length ? erros.join(" | ") : "nenhum")

// ── 7. limpeza: o teste não deixa lixo na base ─────────────────────────────
if (criada.receitaId) {
  await panel.evaluate(
    async ([tk, id, base]) => {
      await fetch(`${base}/api/recipes/${id}`, {
        method: "DELETE",
        headers: { "X-Griver-Token": tk },
      })
    },
    [token, criada.receitaId, serverUrl],
  )
}
if (criada.projetoId) {
  await panel.evaluate(
    async ([tk, id, base]) => {
      await fetch(`${base}/api/projects/${id}`, {
        method: "DELETE",
        headers: { "X-Griver-Token": tk },
      })
    },
    [token, criada.projetoId, serverUrl],
  )
}

await context.close()

const ok =
  estrutura.temHeader &&
  estrutura.temMais &&
  estrutura.temStatus.length > 0 &&
  estrutura.temBody &&
  estrutura.temSecao === "Receitas" &&
  acoes.ok &&
  acoes.truncado &&
  modal.ok &&
  chat.temConversa &&
  voltou &&
  erros.length === 0
console.log(ok ? "\n✓ painel ok" : "\n✗ painel com problemas")
process.exit(ok ? 0 : 1)
