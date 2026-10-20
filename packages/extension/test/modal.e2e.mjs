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
import { join, resolve } from "node:path"

const extensionPath = resolve("packages/extension/dist")
const serverUrl = process.argv[2] ?? "http://127.0.0.1:7331"

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

const erros = []
let worker = context.serviceWorkers()[0]
if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 })

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
// o botão "Conectar" fica na tela de Ajustes
await panel.evaluate(async ([url]) => {
  await chrome.storage.local.set({ "griver.serverUrl": url })
  document.querySelector('.panel-header button[title="Ajustes"]')?.click()
}, [serverUrl])
await panel.waitForTimeout(400)
await panel.evaluate(() => {
  Array.from(document.querySelectorAll("button"))
    .find((b) => b.textContent?.trim() === "Conectar")
    ?.click()
})
await panel.waitForTimeout(1500)

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
const nome = `Script do teste ${Date.now()}`
await panel.evaluate((nome) => {
  const el = document.querySelector(".modal")
  const campos = el?.querySelectorAll("input") ?? []
  const nameInput = campos[0]
  const urlInput = campos[1]
  if (nameInput) {
    nameInput.value = nome
    nameInput.dispatchEvent(new Event("input", { bubbles: true }))
  }
  if (urlInput) {
    urlInput.value = "https://exemplo.com/pagina"
    urlInput.dispatchEvent(new Event("input", { bubbles: true }))
  }
}, nome)
await panel.waitForTimeout(200)

await panel.evaluate(() => {
  Array.from(document.querySelectorAll(".modal button"))
    .find((b) => b.textContent?.trim() === "Save")
    ?.click()
})
await panel.waitForTimeout(1500)

const aviso = await panel.evaluate(
  () => document.querySelector(".notice")?.textContent?.trim() ?? "",
)
console.log("3. aviso ao salvar:", aviso || "(nenhum)")

// ── a receita chegou ao servidor com o startUrl? ────────────────────────────
const checada = await panel.evaluate(async ([tk, alvo]) => {
  const r = await fetch("http://127.0.0.1:7331/api/recipes", {
    headers: { "X-Griver-Token": tk },
  })
  const body = await r.json()
  const found = (body.recipes ?? []).find((x) => x.name === alvo)
  if (!found) return { ok: false, motivo: "receita não está no servidor" }
  const detalhe = await fetch(`http://127.0.0.1:7331/api/recipes/${found.id}`, {
    headers: { "X-Griver-Token": tk },
  })
  const full = await detalhe.json()
  return {
    ok: true,
    startUrl: full.body?.startUrl ?? "",
    passos: full.body?.steps?.length ?? -1,
    id: found.id,
  }
}, [token, nome])

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
    async ([tk, id]) => {
      await fetch(`http://127.0.0.1:7331/api/recipes/${id}`, {
        method: "DELETE",
        headers: { "X-Griver-Token": tk },
      })
    },
    [token, checada.id],
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
