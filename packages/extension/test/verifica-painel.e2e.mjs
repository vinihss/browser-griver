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
 * Uso: node packages/extension/test/verifica-painel.e2e.mjs [serverUrl]
 */
import { chromium } from "playwright"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const extensionPath = resolve("packages/extension/dist")
const serverUrl = process.argv[2] ?? "http://127.0.0.1:7331"

const userDataDir = mkdtempSync(join(tmpdir(), "griver-verifica-"))

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
})

const erros = []

let worker = context.serviceWorkers()[0]
if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 })

const panelUrl = `chrome-extension://${new URL(worker.url()).host}/panel.html`
const panel = await context.newPage()

// qualquer erro de runtime na página do painel é falha do teste
panel.on("pageerror", (error) => erros.push(`pageerror: ${error.message}`))
panel.on("console", (msg) => {
  if (msg.type() === "error") erros.push(`console: ${msg.text()}`)
})

await panel.goto(panelUrl)
await panel.waitForTimeout(1200)

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
await panel.waitForTimeout(1500)
const receitas = await panel.evaluate(() =>
  Array.from(document.querySelectorAll(".recipe-row .truncate")).map(
    (el) => el.textContent?.trim() ?? "",
  ),
)
console.log("3. receitas carregadas automaticamente:", receitas.length ? receitas.join(", ") : "(nenhuma)")

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
console.log("4. botões de ação (Edit, Run):", acoes.ok ? "sim" : `NÃO (${JSON.stringify(acoes)})`)
console.log("5. título truncado:", acoes.truncado ? "sim" : "NÃO")

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
console.log("6. modal Add New Script:", modal.ok ? `sim (${modal.labels.join(", ")} | ${modal.botoes.join(", ")})` : "NÃO")

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
console.log("7. Chat alternado:", chat.temConversa && !chat.temReceitas ? "sim" : `NÃO (${JSON.stringify(chat)})`)

// volta para Receitas
await panel.evaluate(() => {
  const botao = document.querySelector('.panel-header button[title="Receitas"]')
  botao?.click()
})
await panel.waitForTimeout(500)

const voltou = await panel.evaluate(() => Boolean(document.querySelector(".recipe-row")))
console.log("8. voltou para Receitas:", voltou ? "sim" : "NÃO")

// ── 6. erros de runtime ────────────────────────────────────────────────────
console.log("\nerros de runtime:", erros.length ? erros.join(" | ") : "nenhum")

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
