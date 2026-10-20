/**
 * Teste do overlay de gravação dentro da página.
 *
 * Cobre o ponto mais arriscado do novo esquema: o overlay é injetado na
 * página, e a página morre a cada navegação — mas a gravação precisa
 * sobreviver a ela, senão o primeiro passo de qualquer receita se perde.
 *
 * Uso: node packages/extension/test/overlay.e2e.mjs [serverUrl]
 */
import { chromium } from "playwright"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXTENSION_PATH, apontaParaServidor, conectar, fecharAoFalhar } from "./helpers.mjs"

const extensionPath = EXTENSION_PATH
const serverUrl = process.argv[2] ?? "http://127.0.0.1:7331"

const userDataDir = mkdtempSync(join(tmpdir(), "griver-overlay-"))

// página de teste: tem um campo e um link para outra página
const siteDir = mkdtempSync(join(tmpdir(), "griver-site-"))
const pagina1 = join(siteDir, "a.html")
const pagina2 = join(siteDir, "b.html")
writeFileSync(
  pagina1,
  `<!doctype html><meta charset="utf-8"><title>Página A</title>
   <h1>A</h1><input id="nome" /><a id="ir" href="${pagina2}">ir para B</a>
   <button id="enviar">Enviar</button>`,
)
writeFileSync(
  pagina2,
  `<!doctype html><meta charset="utf-8"><title>Página B</title>
   <h1>B</h1><input id="outro" /><button id="ok">OK</button>`,
)

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

fecharAoFalhar(context)

const erros = []
let worker = context.serviceWorkers()[0]
if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 })

// o endereço do servidor é gravado antes do painel abrir: senão ele nasce
// apontando para o servidor padrão e erra o endereço
await apontaParaServidor(worker, serverUrl)

const panel = await context.newPage()
panel.on("pageerror", (error) => erros.push(`panel: ${error.message}`))

const page = await context.newPage()
page.on("pageerror", (error) => erros.push(`page: ${error.message}`))

await page.goto(`file://${pagina1}`)
await page.waitForTimeout(600)

// ── 1. o overlay não existe antes de gravar ────────────────────────────────
const antes = await page.evaluate(() => Boolean(document.querySelector("[data-griver-overlay]")))
console.log("1. overlay antes de gravar:", antes ? "sim (inesperado)" : "não (ok)")

// ── 2. conectar e iniciar a gravação pelo painel ────────────────────────────
await panel.goto(`chrome-extension://${new URL(worker.url()).host}/panel.html`)
// o painel é um módulo: espera o header existir antes de clicar, senão o
// `?.click()` vira no-op e o teste falha sem dizer por quê
await panel.waitForSelector(".panel-header", { timeout: 15000 })
await panel.waitForTimeout(500)

// espera a conexão ficar de fato online: sem isso a gravação começa sem o
// servidor conectado e nenhum passo é registrado
const online = await conectar(panel, serverUrl)
console.log("2. conectado ao servidor:", online ? "sim" : "NÃO")

// volta para Receitas, onde fica o botão de gravar
await panel.evaluate(() => {
  document.querySelector('.panel-header button[title="Receitas"]')?.click()
})
await panel.waitForTimeout(500)
await page.bringToFront()
await panel.evaluate(() => {
  const botao = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "● Gravar",
  )
  botao?.click()
})
await panel.waitForTimeout(1200)

// ── 3. o overlay apareceu na página? ────────────────────────────────────────
const overlay = await page.evaluate(() => {
  const host = document.querySelector("[data-griver-overlay]")
  if (!host) return { ok: false }
  const root = host.shadowRoot
  if (!root) return { ok: false, motivo: "sem shadow root" }
  const botoes = Array.from(root.querySelectorAll("button")).map((b) => b.textContent?.trim())
  const titulo = root.querySelector(".griver-panel-title")?.textContent?.trim() ?? ""
  const passos = root.querySelectorAll(".griver-step").length
  return { ok: true, botoes, titulo, passos }
})
console.log("2. overlay na página:", overlay.ok ? "sim" : `NÃO (${JSON.stringify(overlay)})`)
console.log("3. botões do overlay:", overlay.botoes?.join(", ") ?? "-")
console.log("4. painel de passos:", overlay.titulo, `(${overlay.passos} passos)`)

// ── 4. o clique na página é capturado? ──────────────────────────────────────
await page.bringToFront()
await page.click("#nome")
await page.fill("#nome", "Vinicius")
await page.waitForTimeout(700)

const comClique = await page.evaluate(() => {
  const host = document.querySelector("[data-griver-overlay]")
  const root = host?.shadowRoot
  return Array.from(root?.querySelectorAll(".griver-step") ?? []).map((s) => s.textContent?.trim())
})
console.log("5. passos capturados:", comClique.length ? comClique.join(" | ") : "(nenhum)")

// ── 5. ⚠️ navegar: o overlay e a captura precisam sobreviver ─────────────────
await page.bringToFront()
await page.click("#ir")
await page.waitForTimeout(1800)

const depois = await page.evaluate(() => {
  const host = document.querySelector("[data-griver-overlay]")
  if (!host) return { ok: false, motivo: "overlay sumiu após navegar" }
  const root = host.shadowRoot
  const passos = Array.from(root?.querySelectorAll(".griver-step") ?? []).map((s) => s.textContent?.trim())
  return { ok: true, passos }
})
console.log("6. overlay após navegar:", depois.ok ? "sobreviveu" : `PERDEU (${depois.motivo})`)
console.log("7. passos após navegar:", depois.passos?.length ? depois.passos.join(" | ") : "(nenhum)")

// ── 6. a captura continua funcionando depois da navegação? ──────────────────
// o botão é gravado como clique; o input de texto vira um preenchimento
await page.bringToFront()
await page.fill("#outro", "depois")
await page.click("#ok")
await page.waitForTimeout(900)

const final = await page.evaluate(() => {
  const host = document.querySelector("[data-griver-overlay]")
  const root = host?.shadowRoot
  return Array.from(root?.querySelectorAll(".griver-step") ?? []).map((s) => s.textContent?.trim())
})
console.log("8. passos finais:", final.length ? final.join(" | ") : "(nenhum)")

// ── 7. parar a gravação ─────────────────────────────────────────────────────
await page.bringToFront()
await page.evaluate(() => {
  const host = document.querySelector("[data-griver-overlay]")
  const root = host?.shadowRoot
  const botao = Array.from(root?.querySelectorAll(".griver-icon-btn") ?? []).find(
    (b) => b.title === "Stop",
  )
  botao?.click()
})
await panel.waitForTimeout(1500)

const parada = await panel.evaluate(() => {
  const texto = document.querySelector(".notice")?.textContent?.trim() ?? ""
  return texto
})
console.log("9. aviso ao parar:", parada || "(nenhum)")

// ── 8. o "✎" (Edit) abre o editor no painel? ────────────────────────────────
await page.bringToFront()
await page.evaluate(() => {
  const host = document.querySelector("[data-griver-overlay]")
  const root = host?.shadowRoot
  const botao = Array.from(root?.querySelectorAll(".griver-icon-btn") ?? []).find(
    (b) => b.title === "Editar",
  )
  botao?.click()
})
await panel.waitForTimeout(1000)

const editor = await panel.evaluate(() => {
  const textarea = document.querySelector("textarea.code")
  const aviso = document.querySelector(".notice")?.textContent?.trim() ?? ""
  let passos = -1
  if (textarea) {
    try {
      passos = JSON.parse(textarea.value).steps?.length ?? -1
    } catch {
      passos = -2
    }
  }
  return { temEditor: Boolean(textarea), passos, aviso }
})
console.log("10. editor aberto no painel:", editor.temEditor ? "sim" : "NÃO")
console.log("11. passos no editor:", editor.passos >= 0 ? editor.passos : "(inválido)")

// ── 9. erros de runtime ────────────────────────────────────────────────────
console.log("\nerros de runtime:", erros.length ? erros.join(" | ") : "nenhum")

await context.close()

const navegou = final.length > comClique.length
const ok =
  overlay.ok &&
  comClique.length > 0 &&
  depois.ok &&
  navegou &&
  editor.temEditor &&
  editor.passos > 0 &&
  erros.length === 0
console.log(ok ? "\n✓ overlay ok" : "\n✗ overlay com problemas")
process.exit(ok ? 0 : 1)
