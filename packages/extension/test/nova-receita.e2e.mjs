/**
 * Teste do fluxo de criar uma receita na tela dedicada de edição.
 *
 * Clica no `+` do painel — em vez do antigo modal, a tela de edição abre
 * com Nome, editor JSON, ações e o botão "● Gravar". Preenche só o nome e
 * confere se a receita chega ao servidor com o `startUrl` da página em que
 * o teste está — não há campo de URL em nenhum lugar do fluxo.
 *
 * Uso: node packages/extension/test/nova-receita.e2e.mjs <serverUrl>
 */
import { chromium } from "playwright"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXTENSION_PATH, apontaParaServidor, conectar, fecharAoFalhar, opcoesDoNavegador, servidorDoTeste } from "./helpers.mjs"

const extensionPath = EXTENSION_PATH
const serverUrl = servidorDoTeste(process.argv.slice(2))

const userDataDir = mkdtempSync(join(tmpdir(), "griver-nova-"))
const siteDir = mkdtempSync(join(tmpdir(), "griver-site-"))
const pagina = join(siteDir, "a.html")
writeFileSync(
  pagina,
  `<!doctype html><meta charset="utf-8"><title>A</title><input id="nome"><button id="b">B</button>`,
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

// a URL da página em que o teste está: é ela que a receita guarda como
// `startUrl`, já que o fluxo não tem campo de URL
const urlEsperada = `file://${pagina}`

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

// ── o "+" abre a tela de edição? ────────────────────────────────────────────
// o clique pode cair durante um redesenho do painel: tenta algumas vezes
let tela = { ok: false, campos: [], botoes: [], modal: false }
for (let tentativa = 0; tentativa < 5 && !tela.ok; tentativa++) {
  await panel.evaluate(() => {
    document
      .querySelector(
        '.panel-header button[title="Add New Script"], .panel-header button[aria-label="Add New Script"]',
      )
      ?.click()
  })
  await panel.waitForTimeout(400)
  tela = await panel.evaluate(() => {
    if (document.querySelector(".modal")) return { ok: false, campos: [], botoes: [], modal: true }
    const campos = Array.from(document.querySelectorAll(".view input")).map(
      (i) => i.placeholder,
    )
    const temEditor = Boolean(document.querySelector(".view textarea"))
    const botoes = Array.from(document.querySelectorAll(".view button")).map(
      (b) => b.textContent?.trim(),
    )
    return { ok: temEditor && campos.length === 1, campos, botoes, modal: false }
  })
}
console.log("2. tela de edição aberta:", tela.ok ? "sim" : "NÃO", tela.campos?.join(", ") ?? "")
console.log("2. botões da tela:", tela.botoes?.join(", ") ?? "(nenhum)")
console.log("2. alguma modal na tela:", tela.modal ? "SIM" : "não")

// o gravar mora na tela de edição, não na lista
const temGravar = tela.botoes?.some((b) => b?.includes("Gravar")) ?? false
console.log("2. botão Gravar na tela:", temGravar ? "sim" : "NÃO")

// ── preencher e salvar ──────────────────────────────────────────────────────
// a tela é recriada a cada redesenho do painel: preenche e confere que o
// valor sobreviveu, senão o clique no Salvar acha outro elemento
const nome = `Script do teste ${Date.now()}`
const preencheu = await panel.evaluate((nome) => {
  const campos = document.querySelectorAll(".view input")
  // só o nome: a URL da página é a fonte do `startUrl`
  if (campos.length !== 1) return false
  const nameInput = campos[0]
  nameInput.value = nome
  nameInput.dispatchEvent(new Event("input", { bubbles: true }))
  return true
}, nome)
console.log("3. campos preenchidos:", preencheu ? "sim" : "NÃO")
await panel.waitForTimeout(400)

const salvou = await panel.evaluate(() => {
  const botao = Array.from(document.querySelectorAll(".view button")).find(
    (b) => b.textContent?.trim() === "Salvar",
  )
  if (!botao) return false
  botao.click()
  return true
})
console.log("4. botão Salvar acionado:", salvou ? "sim" : "NÃO")
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

// ── voltar para a lista mostra a receita nova? ──────────────────────────────
// depois de salvar a tela continua na edição: a lista só aparece quando o
// usuário clica em voltar
await panel.evaluate(() => {
  document.querySelector('button[aria-label="Voltar para a lista"]')?.click()
})
await panel.waitForTimeout(600)

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
  tela.ok &&
  !tela.modal &&
  temGravar &&
  salvou &&
  checada.ok &&
  checada.startUrl === urlEsperada &&
  naLista &&
  erros.length === 0
console.log(ok ? "\n✓ nova receita ok" : "\n✗ nova receita com problemas")
process.exit(ok ? 0 : 1)
