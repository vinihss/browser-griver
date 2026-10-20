/**
 * Teste do fluxo completo do modal "Add New Script".
 *
 * Grava uma receita, para, abre o modal pelo `+` do painel, preenche Name e
 * URL e confere se a receita chega ao servidor com o `startUrl` certo.
 *
 * Uso: node packages/extension/test/modal.e2e.mjs [serverUrl]
 */
import { chromium } from "playwright"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXTENSION_PATH, apontaParaServidor, conectar, fecharAoFalhar, servidorDoTeste } from "./helpers.mjs"

const extensionPath = EXTENSION_PATH
const serverUrl = servidorDoTeste(process.argv.slice(2))

const userDataDir = mkdtempSync(join(tmpdir(), "griver-modal-"))
const siteDir = mkdtempSync(join(tmpdir(), "griver-site-"))
const pagina = join(siteDir, "a.html")
writeFileSync(
  pagina,
  `<!doctype html><meta charset="utf-8"><title>A</title><input id="nome"><button id="b">B</button>`,
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
panel.on("console", (msg) => {
  if (msg.type() === "error") erros.push(`console: ${msg.text()}`)
})

const page = await context.newPage()
page.on("pageerror", (error) => erros.push(`page: ${error.message}`))

await page.goto(`file://${pagina}`)
await page.waitForTimeout(500)
await panel.goto(`chrome-extension://${new URL(worker.url()).host}/panel.html`)
// o painel é um módulo: espera o header existir antes de clicar, senão o
// `?.click()` vira no-op e o teste falha sem dizer por quê
await panel.waitForSelector(".panel-header", { timeout: 15000 })
await panel.waitForTimeout(500)

// ── conectar ────────────────────────────────────────────────────────────────
// o endereço vai pelo campo de texto do painel: só assim a extensão
// reconecta ao servidor certo e renova o token
const online = await conectar(panel, serverUrl)
console.log("1. conectado:", online ? "sim" : "NÃO")

// volta para Receitas, que é a tela inicial
await panel.evaluate(() => {
  document.querySelector('.panel-header button[title="Receitas"]')?.click()
})
await panel.waitForTimeout(400)

const token = await panel.evaluate(async () => {
  const guardado = await chrome.storage.local.get("griver.token")
  return guardado["griver.token"] ?? ""
})
console.log("1. token obtido:", token ? "sim" : "NÃO")

// ── o "+" abre o modal? ─────────────────────────────────────────────────────
// o modal só existe na tela de Receitas: volta para lá antes de abrir
await panel.evaluate(() => {
  document.querySelector('.panel-header button[title="Receitas"]')?.click()
})
await panel.waitForTimeout(600)

// o clique pode cair durante um redesenho do painel: tenta algumas vezes
let modal = { ok: false, campos: [] }
for (let tentativa = 0; tentativa < 5 && !modal.ok; tentativa++) {
  await panel.evaluate(() => {
    document
      .querySelector(
        '.panel-header button[title="Add New Script"], .panel-header button[aria-label="Add New Script"]',
      )
      ?.click()
  })
  await panel.waitForTimeout(400)
  modal = await panel.evaluate(() => {
    const el = document.querySelector(".modal")
    if (!el) return { ok: false, campos: [] }
    const campos = Array.from(el.querySelectorAll("input")).map((i) => i.placeholder)
    return { ok: true, campos }
  })
}
console.log("2. modal aberto:", modal.ok ? "sim" : "NÃO", modal.campos?.join(", ") ?? "")

// ── preencher e salvar ──────────────────────────────────────────────────────
// o modal é recriado a cada redesenho do painel: preenche e confere que os
// valores sobreviveram, senão o clique no Save acha outro elemento
const nome = `Script do teste ${Date.now()}`
const preencheu = await panel.evaluate((nome) => {
  const el = document.querySelector(".modal")
  if (!el) return false
  const campos = el.querySelectorAll("input")
  const nameInput = campos[0]
  const urlInput = campos[1]
  if (!nameInput || !urlInput) return false
  nameInput.value = nome
  nameInput.dispatchEvent(new Event("input", { bubbles: true }))
  urlInput.value = "https://exemplo.com/pagina"
  urlInput.dispatchEvent(new Event("input", { bubbles: true }))
  return true
}, nome)
console.log("3. campos preenchidos:", preencheu ? "sim" : "NÃO")
await panel.waitForTimeout(400)

// o clique precisa acertar o modal atual
const salvou = await panel.evaluate(() => {
  const botao = Array.from(document.querySelectorAll(".modal button")).find(
    (b) => b.textContent?.trim() === "Save",
  )
  if (!botao) return false
  botao.click()
  return true
})
console.log("4. botão Save acionado:", salvou ? "sim" : "NÃO")
await panel.waitForTimeout(1500)

const aviso = await panel.evaluate(
  () => document.querySelector(".notice")?.textContent?.trim() ?? "",
)
console.log("5. aviso ao salvar:", aviso || "(nenhum)")

// ── a receita chegou ao servidor com o startUrl? ────────────────────────────
const checada = await panel.evaluate(async ([tk, alvo, base]) => {
  const r = await fetch(`${base}/api/recipes`, {
    headers: { "X-Griver-Token": tk },
  })
  const body = await r.json()
  const found = (body.recipes ?? []).find((x) => x.name === alvo)
  if (!found) return { ok: false, motivo: "receita não está no servidor" }
  const detalhe = await fetch(`${base}/api/recipes/${found.id}`, {
    headers: { "X-Griver-Token": tk },
  })
  const full = await detalhe.json()
  return {
    ok: true,
    startUrl: full.body?.startUrl ?? "",
    passos: full.body?.steps?.length ?? -1,
    id: found.id,
  }
}, [token, nome, serverUrl])

console.log("4. receita no servidor:", checada.ok ? "sim" : `NÃO (${checada.motivo})`)
console.log("5. startUrl:", checada.startUrl)
console.log("6. passos:", checada.passos)
// ── a lista do painel mostra a receita nova? ────────────────────────────────
const naLista = await panel.evaluate(
  (alvo) =>
    Array.from(document.querySelectorAll(".recipe-row .truncate")).some(
      (el) => el.textContent?.trim() === alvo,
    ),
  nome,
)
console.log("7. aparece na lista do painel:", naLista ? "sim" : "NÃO")

// ── limpeza ─────────────────────────────────────────────────────────────────
if (checada.ok) {
  await panel.evaluate(
    async ([tk, id, base]) => {
      await fetch(`${base}/api/recipes/${id}`, {
        method: "DELETE",
        headers: { "X-Griver-Token": tk },
      })
    },
    [token, checada.id, serverUrl],
  )
}

console.log("\nerros de runtime:", erros.length ? erros.join(" | ") : "nenhum")

await context.close()

const ok =
  modal.ok &&
  checada.ok &&
  checada.startUrl === "https://exemplo.com/pagina" &&
  naLista &&
  erros.length === 0
console.log(ok ? "\n✓ modal ok" : "\n✗ modal com problemas")
process.exit(ok ? 0 : 1)
