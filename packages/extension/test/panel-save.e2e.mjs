/**
 * Teste end-to-end do fluxo de gravar e salvar uma receita.
 *
 * Reproduz o caminho de uma pessoa: clica em "● Gravar" no painel, interage
 * com a página, para a gravação pelo overlay, edita no painel e salva — e
 * confere se os passos gravados realmente chegaram ao servidor.
 *
 * Uso: node packages/extension/test/panel-save.e2e.mjs <serverUrl> [targetUrl]
 */
import { chromium } from "playwright"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXTENSION_PATH, apontaParaServidor, conectar, fecharAoFalhar, servidorDoTeste } from "./helpers.mjs"

const extensionPath = EXTENSION_PATH
const serverUrl = servidorDoTeste(process.argv.slice(2))
const targetUrl = process.argv[3] ?? "file:///tmp/opencode/teste.html"

const userDataDir = mkdtempSync(join(tmpdir(), "griver-panel-"))

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

let worker = context.serviceWorkers()[0]
if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 })

// o endereço do servidor é gravado antes do painel abrir: senão ele nasce
// apontando para o servidor padrão e erra o endereço
await apontaParaServidor(worker, serverUrl)

const panelUrl = `chrome-extension://${new URL(worker.url()).host}/panel.html`
const panel = await context.newPage()
await panel.goto(panelUrl)
// o painel é um módulo: espera o header existir antes de clicar, senão o
// `?.click()` vira no-op e o teste falha sem dizer por quê
await panel.waitForSelector(".panel-header", { timeout: 15000 })
await panel.waitForTimeout(500)

// ── 1. conectar ────────────────────────────────────────────────────────────
// o endereço vai pelo campo de texto do painel: só assim a extensão
// reconecta ao servidor certo e renova o token
const online = await conectar(panel, serverUrl)
console.log("1. conectado:", online ? "sim" : "NÃO")

// volta para Receitas, onde fica o botão de gravar
await panel.evaluate(() => {
  document.querySelector('.panel-header button[title="Receitas"]')?.click()
})
await panel.waitForTimeout(500)

// o token deve ter vindo do servidor, sem colar nada
const tokenObtido = await panel.evaluate(async () => {
  const guardado = await chrome.storage.local.get("griver.token")
  return guardado["griver.token"] ?? ""
})
console.log("1. token obtido automaticamente:", tokenObtido ? "sim" : "NÃO")

const status = await panel.evaluate(() => document.querySelector(".status")?.textContent?.trim())
console.log("2. status no painel:", status)

// o token usado nos testes vem do armazenamento da extensão
const token = await panel.evaluate(async () => {
  const guardado = await chrome.storage.local.get("griver.token")
  return guardado["griver.token"] ?? ""
})

// ── 2. criar projeto e registrar o id para limpar no final ─────────────────
const projeto = await panel.evaluate(async ([tk, base]) => {
  const r = await fetch(`${base}/api/projects`, {
    headers: { "X-Griver-Token": tk },
  })
  const body = await r.json()
  const criado = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { "X-Griver-Token": tk, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Projeto do teste" }),
  })
  const novo = await criado.json()
  return { id: novo.project?.id ?? "", total: body.projects?.length ?? 0 }
}, [token, serverUrl])
console.log("3. projeto criado:", projeto.id ? "sim" : "não")

// ── 3. página alvo e gravação ──────────────────────────────────────────────
const page = await context.newPage()
await page.goto(targetUrl)
await page.waitForTimeout(600)

// a gravação começa pelo painel, mas acontece na aba da página
await page.bringToFront()
await panel.evaluate(() => {
  Array.from(document.querySelectorAll("button"))
    .find((b) => b.textContent?.trim() === "● Gravar")
    ?.click()
})
await panel.waitForTimeout(1200)
console.log("4. gravação iniciada")

// o overlay tem que estar na página
const overlay = await page.evaluate(() => {
  const host = document.querySelector("[data-griver-overlay]")
  return Boolean(host?.shadowRoot)
})
console.log("5. overlay na página:", overlay ? "sim" : "NÃO")

await page.click("#nome")
await page.fill("#nome", "Vinicius")
await page.selectOption("#plano", "pro")
await page.click("#enviar")
await page.waitForTimeout(1200)

// ── 4. parar a gravação pelo overlay ───────────────────────────────────────
await page.bringToFront()
await page.evaluate(() => {
  const root = document.querySelector("[data-griver-overlay]")?.shadowRoot
  Array.from(root?.querySelectorAll(".griver-icon-btn") ?? [])
    .find((b) => b.title === "Stop")
    ?.click()
})
await panel.waitForTimeout(1500)

const aviso = await panel.evaluate(() => document.querySelector(".notice")?.textContent?.trim())
console.log("6. aviso ao parar:", aviso)

const passosNoOverlay = await page.evaluate(() => {
  const root = document.querySelector("[data-griver-overlay]")?.shadowRoot
  return Array.from(root?.querySelectorAll(".griver-step") ?? []).map((s) => s.textContent?.trim())
})
console.log("7. passos no overlay:", passosNoOverlay.length ? passosNoOverlay.join(" | ") : "(nenhum)")

// ── 5. abrir o editor no painel pelo ✎ do overlay ──────────────────────────
await page.bringToFront()
await page.evaluate(() => {
  const root = document.querySelector("[data-griver-overlay]")?.shadowRoot
  Array.from(root?.querySelectorAll(".griver-icon-btn") ?? [])
    .find((b) => b.title === "Editar")
    ?.click()
})
await panel.waitForTimeout(1000)

const editor = await panel.evaluate(() => {
  const textarea = document.querySelector("textarea.code")
  if (!textarea) return { ok: false }
  const receita = JSON.parse(textarea.value)
  return { ok: true, passos: receita.steps?.length ?? -1 }
})
console.log("8. editor no painel:", editor.ok ? "sim" : "NÃO", `(${editor.passos} passos)`)

// ── 6. editar o JSON e salvar ──────────────────────────────────────────────
const editou = await panel.evaluate(async () => {
  const editor = document.querySelector("textarea.code")
  if (!editor) return { ok: false, motivo: "sem editor" }
  const receita = JSON.parse(editor.value)
  receita.steps.push({ id: "espera-extra", type: "wait", ms: 50 })
  editor.value = JSON.stringify(receita, null, 2)
  editor.dispatchEvent(new Event("input", { bubbles: true }))
  await new Promise((r) => setTimeout(r, 100))
  // "Salvar" num rascunho abre o modal Add New Script
  Array.from(document.querySelectorAll("button"))
    .find((b) => b.textContent?.trim() === "Salvar")
    ?.click()
  await new Promise((r) => setTimeout(r, 400))
  return { ok: true, modal: Boolean(document.querySelector(".modal")) }
})
console.log("9. edição + modal:", JSON.stringify(editou))

const nomeReceita = "Minha receita"
await panel.evaluate((nome) => {
  const campos = document.querySelectorAll(".modal input")
  const nameInput = campos[0]
  if (nameInput) {
    nameInput.value = nome
    nameInput.dispatchEvent(new Event("input", { bubbles: true }))
  }
  Array.from(document.querySelectorAll(".modal button"))
    .find((b) => b.textContent?.trim() === "Save")
    ?.click()
}, nomeReceita)
await panel.waitForTimeout(1500)

const avisoFinal = await panel.evaluate(() => document.querySelector(".notice")?.textContent?.trim())
console.log("10. aviso final:", avisoFinal)

// ── 7. conferência no servidor ─────────────────────────────────────────────
const receitas = await panel.evaluate(async ([tk, base]) => {
  const r = await fetch(`${base}/api/recipes`, {
    headers: { "X-Griver-Token": tk },
  })
  const body = await r.json()
  return body.recipes ?? []
}, [token, serverUrl])

console.log("\nreceitas no servidor:")
for (const receita of receitas) {
  console.log(`  ${receita.id.slice(0, 8)}  ${receita.name}  [${receita.target}] ${receita.stepCount} passos`)
}

const gravada = receitas.find((r) => r.name === nomeReceita)
if (!gravada) {
  console.log("\n✗ a receita não foi salva")
  await context.close()
  process.exit(1)
}

const detalhe = await panel.evaluate(
  async ([tk, id, base]) => {
    const r = await fetch(`${base}/api/recipes/${id}`, {
      headers: { "X-Griver-Token": tk },
    })
    const body = await r.json()
    return body.body ?? {}
  },
  [token, gravada.id, serverUrl],
)

const passos = detalhe.steps ?? []
console.log("passos gravados:", passos.length)
for (const passo of passos) {
  console.log(`  ${passo.type} ${passo.target?.selectors?.[0] ?? passo.url ?? ""}`)
}

// ── 8. executar a receita na aba e conferir o resultado ────────────────────
await page.bringToFront()
await panel.evaluate(() => {
  Array.from(document.querySelectorAll(".recipe-row"))
    .find((row) => row.textContent?.includes("Minha receita"))
    ?.querySelector(".row-actions button:last-child")
    ?.click()
})
await page.waitForTimeout(800)

let textoResultado = ""
for (let tentativa = 0; tentativa < 40; tentativa++) {
  await new Promise((r) => setTimeout(r, 500))
  textoResultado = await page
    .evaluate(() => document.querySelector("#resultado")?.textContent ?? "")
    .catch(() => "")
  if (textoResultado) break
}
console.log("resultado na página:", JSON.stringify(textoResultado))

// ── 9. limpeza: o teste não deixa lixo na base do usuário ─────────────────
await panel.evaluate(
  async ([tk, id, base]) => {
    await fetch(`${base}/api/recipes/${id}`, {
      method: "DELETE",
      headers: { "X-Griver-Token": tk },
    })
  },
  [token, gravada.id, serverUrl],
)
if (projeto.id) {
  await panel.evaluate(
    async ([tk, id, base]) => {
      await fetch(`${base}/api/projects/${id}`, {
        method: "DELETE",
        headers: { "X-Griver-Token": tk },
      })
    },
    [token, projeto.id, serverUrl],
  )
}

await context.close()
const ok = passos.length > 0 && textoResultado.includes("Vinicius")
console.log(ok ? "\n✓ receita salva e executada corretamente" : "\n✗ a receita não funcionou")
process.exit(ok ? 0 : 1)
