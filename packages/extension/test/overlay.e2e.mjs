/**
 * Teste da barra de gravação dentro da página.
 *
 * Cobre o ponto mais arriscado do esquema: a barra é injetada na página, e
 * a página morre a cada navegação — mas a gravação precisa sobreviver a
 * ela, senão o primeiro passo de qualquer receita se perde. E cobre o
 * fim do fluxo: quando a gravação para, a barra some da página (nada fica
 * preso na tela) e os passos abrem na tela de edição do painel.
 *
 * Uso: node packages/extension/test/overlay.e2e.mjs <serverUrl>
 */
import { chromium } from "playwright"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXTENSION_PATH, apontaParaServidor, conectar, fecharAoFalhar, opcoesDoNavegador, servidorDoTeste } from "./helpers.mjs"

const extensionPath = EXTENSION_PATH
const serverUrl = servidorDoTeste(process.argv.slice(2))

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

const panel = await context.newPage()
panel.on("pageerror", (error) => erros.push(`panel: ${error.message}`))

const page = await context.newPage()
page.on("pageerror", (error) => erros.push(`page: ${error.message}`))

await page.goto(`file://${pagina1}`)
await page.waitForTimeout(600)

// ── 1. a barra não existe antes de gravar ───────────────────────────────────
const antes = await page.evaluate(() => Boolean(document.querySelector("[data-griver-overlay]")))
console.log("1. barra antes de gravar:", antes ? "sim (inesperado)" : "não (ok)")

// ── 2. conectar e abrir a tela de edição pelo "+" ───────────────────────────
await panel.goto(`chrome-extension://${new URL(worker.url()).host}/panel.html`)
// o painel é um módulo: espera o header existir antes de clicar, senão o
// `?.click()` vira no-op e o teste falha sem dizer por quê
await panel.waitForSelector(".panel-header", { timeout: 15000 })
await panel.waitForTimeout(500)

// espera a conexão ficar de fato online: sem isso a gravação começa sem o
// servidor conectado e nenhum passo é registrado
const online = await conectar(panel, serverUrl)
console.log("2. conectado ao servidor:", online ? "sim" : "NÃO")

// o gravar mora na tela de edição: o "+" abre essa tela
await panel.evaluate(() => {
  document
    .querySelector(
      '.panel-header button[title="Add New Script"], .panel-header button[aria-label="Add New Script"]',
    )
    ?.click()
})
await panel.waitForTimeout(600)

const nomeDaTela = await panel.evaluate(() => {
  const input = document.querySelector(".view input")
  if (!input) return ""
  input.value = `Overlay ${Date.now()}`
  input.dispatchEvent(new Event("input", { bubbles: true }))
  return input.value
})
console.log("2. tela de edição com nome:", nomeDaTela ? "sim" : "NÃO")

// ── 3. gravar a partir da tela de edição ────────────────────────────────────
await page.bringToFront()
await panel.evaluate(() => {
  const botao = Array.from(document.querySelectorAll(".view button")).find(
    (b) => b.textContent?.trim() === "● Gravar",
  )
  botao?.click()
})
await panel.waitForTimeout(1500)

// ── 4. a barra apareceu na página? ──────────────────────────────────────────
const barra = await page.evaluate(() => {
  const host = document.querySelector("[data-griver-overlay]")
  if (!host) return { ok: false }
  const root = host.shadowRoot
  if (!root) return { ok: false, motivo: "sem shadow root" }
  const botoes = Array.from(root.querySelectorAll("button")).map((b) => b.title || b.textContent)
  // a página não tem mais lista de passos: nem painel, nem passos
  const temPainel = Boolean(root.querySelector(".griver-panel-title"))
  const passos = root.querySelectorAll(".griver-step").length
  return { ok: true, botoes, temPainel, passos }
})
console.log("4. barra na página:", barra.ok ? "sim" : `NÃO (${JSON.stringify(barra)})`)
console.log("5. botões da barra:", barra.botoes?.join(", ") ?? "-")
console.log("5. lista de passos na página:", barra.temPainel || barra.passos > 0 ? "SIM" : "não")

// o contador de passos vive no painel (o badge "gravando · N passos")
const contador = () =>
  panel.evaluate(() => {
    const texto = document.querySelector(".badge-rec")?.textContent?.trim() ?? ""
    const achou = texto.match(/(\d+)/)
    return achou ? Number(achou[1]) : 0
  })

// ── 5. o clique na página é capturado? ──────────────────────────────────────
await page.bringToFront()
await page.click("#nome")
await page.fill("#nome", "Vinicius")
await page.waitForTimeout(900)

const comClique = await contador()
console.log("6. passos capturados:", comClique)

// ── 6. ⚠️ navegar: a barra e a captura precisam sobreviver ──────────────────
await page.bringToFront()
await page.click("#ir")
await page.waitForTimeout(1800)

const depois = await page.evaluate(() => {
  const host = document.querySelector("[data-griver-overlay]")
  if (!host) return { ok: false, motivo: "barra sumiu após navegar" }
  return { ok: Boolean(host.shadowRoot) }
})
const passosAposNavegar = await contador()
console.log("7. barra após navegar:", depois.ok ? "sobreviveu" : `PERDEU (${depois.motivo})`)
console.log("8. passos após navegar:", passosAposNavegar)

// ── 7. a captura continua funcionando depois da navegação? ──────────────────
// o botão é gravado como clique; o input de texto vira um preenchimento
await page.bringToFront()
await page.fill("#outro", "depois")
await page.click("#ok")
await page.waitForTimeout(900)

const finais = await contador()
console.log("9. passos finais:", finais)

// ── 8. parar a gravação pela barra ──────────────────────────────────────────
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

const aviso = await panel.evaluate(() => document.querySelector(".notice")?.textContent?.trim() ?? "")
console.log("10. aviso ao parar:", aviso || "(nenhum)")

// a barra some da página: nada fica preso na tela depois de parar
const sumiu = await page.evaluate(() => !document.querySelector("[data-griver-overlay]"))
console.log("11. barra some da página ao parar:", sumiu ? "sim" : "NÃO")

// ── 9. os passos abrem sozinhos na tela de edição do painel ────────────────
const editor = await panel.evaluate(() => {
  const textarea = document.querySelector("textarea.code")
  let passos = -1
  if (textarea) {
    try {
      passos = JSON.parse(textarea.value).steps?.length ?? -1
    } catch {
      passos = -2
    }
  }
  return { temEditor: Boolean(textarea), passos }
})
console.log("12. tela de edição com os passos:", editor.temEditor ? "sim" : "NÃO")
console.log("13. passos no editor:", editor.passos >= 0 ? editor.passos : "(inválido)")

// ── 10. erros de runtime ────────────────────────────────────────────────────
console.log("\nerros de runtime:", erros.length ? erros.join(" | ") : "nenhum")

await context.close()

const navegou = finais > comClique
const ok =
  barra.ok &&
  !barra.temPainel &&
  comClique > 0 &&
  depois.ok &&
  navegou &&
  sumiu &&
  editor.temEditor &&
  editor.passos > 0 &&
  erros.length === 0
console.log(ok ? "\n✓ overlay ok" : "\n✗ overlay com problemas")
process.exit(ok ? 0 : 1)
