/**
 * Teste end-to-end do fluxo de salvar receita pela interface.
 *
 * Reproduz o caminho de uma pessoa: escolhe o projeto, grava, conclui e
 * clica em "Salvar como receita" — e confere se os passos gravados
 * realmente chegaram ao servidor.
 */
import { chromium } from "playwright"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const extensionPath = resolve("packages/extension/dist")
const serverUrl = process.argv[2] ?? "http://127.0.0.1:7331"
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

let worker = context.serviceWorkers()[0]
if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 })

const panelUrl = `chrome-extension://${new URL(worker.url()).host}/panel.html`
const panel = await context.newPage()
await panel.goto(panelUrl)
await panel.waitForTimeout(800)

// ── 1. conectar ────────────────────────────────────────────────────────────
await panel.evaluate(
  async ([url]) => {
    await chrome.storage.local.set({ "griver.serverUrl": url })
    const botoes = Array.from(document.querySelectorAll("button"))
    botoes.find((b) => b.textContent?.includes("Conectar"))?.click()
  },
  [serverUrl],
)
await panel.waitForTimeout(1500)

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

// ── 2. criar/selecionar projeto ────────────────────────────────────────────
await panel.evaluate(() => {
  Array.from(document.querySelectorAll(".tab")).find((t) => t.textContent?.includes("Projetos"))?.click()
})
await panel.waitForTimeout(400)

const projetoCriado = await panel.evaluate(async () => {
  const campo = document.querySelector(".view .input")
  if (campo) {
    campo.value = "Projeto do teste"
    campo.dispatchEvent(new Event("input", { bubbles: true }))
  }
  const botao = Array.from(document.querySelectorAll("button")).find((b) =>
    b.textContent?.trim() === "Criar",
  )
  botao?.click()
  await new Promise((r) => setTimeout(r, 800))
  return document.querySelector(".list-item-title")?.textContent?.trim() ?? ""
})
console.log("3. projeto:", projetoCriado)

// id do projeto para limpar no final
const idProjeto = await panel.evaluate(
  async ([tk]) => {
    const r = await fetch("http://127.0.0.1:7331/api/projects", {
      headers: { "X-Griver-Token": tk },
    })
    const body = await r.json()
    return (
      (body.projects ?? []).find((p) => p.name === "Projeto do teste")?.id ?? ""
    )
  },
  [token],
)

// ── 3. página alvo e gravação ──────────────────────────────────────────────
const page = await context.newPage()
await page.goto(targetUrl)
await page.waitForTimeout(600)

await panel.evaluate(() => {
  Array.from(document.querySelectorAll(".tab")).find((t) => t.textContent?.includes("Gravar"))?.click()
})
await panel.waitForTimeout(300)

// a gravação acontece na aba da página, não na do painel
await page.bringToFront()
await panel.evaluate(async () => {
  Array.from(document.querySelectorAll("button"))
    .find((b) => b.textContent?.trim() === "● Gravar")
    ?.click()
  await new Promise((r) => setTimeout(r, 400))
})
console.log("4. gravação iniciada")

await page.click("#nome")
await page.fill("#nome", "Vinicius")
await page.selectOption("#plano", "pro")
await page.click("#enviar")
await page.waitForTimeout(1200)

// ── 4. concluir e salvar ───────────────────────────────────────────────────
const estado = await panel.evaluate(
  async ([tk]) => {
    const r = await fetch("http://127.0.0.1:7331/api/recording", {
      headers: { "X-Griver-Token": tk },
    })
    return await r.json()
  },
  [token],
)

console.log("5. eventos capturados pelo servidor:", estado.events?.length ?? 0)
for (const evento of estado.events ?? []) {
  console.log("   ", evento.kind, evento.selectors?.[0] ?? evento.url ?? "")
}

await panel.evaluate(async () => {
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Concluir"))?.click()
  await new Promise((r) => setTimeout(r, 800))
})
console.log("6. gravação concluída")

const aviso = await panel.evaluate(() => document.querySelector(".notice")?.textContent?.trim())
console.log("7. aviso:", aviso)

const dica = await panel.evaluate(() => document.querySelector(".hint")?.textContent?.trim())
console.log("8. dica do painel:", dica)

await panel.evaluate(async () => {
  const campos = Array.from(document.querySelectorAll(".view input"))
  const nome = campos[campos.length - 1]
  if (nome) {
    nome.value = "Minha receita"
    nome.dispatchEvent(new Event("input", { bubbles: true }))
  }
  const botao = Array.from(document.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Salvar como receita"),
  )
  botao?.click()
  await new Promise((r) => setTimeout(r, 1200))
})
console.log("7. botão salvar acionado")

const avisoFinal = await panel.evaluate(() => document.querySelector(".notice")?.textContent?.trim())
console.log("8. aviso final:", avisoFinal)

// ── 5. conferência no servidor ─────────────────────────────────────────────
const receitas = await panel.evaluate(
  async ([tk]) => {
    const r = await fetch("http://127.0.0.1:7331/api/recipes", {
      headers: { "X-Griver-Token": tk },
    })
    return await r.json()
  },
  [token],
)

console.log("\nreceitas no servidor:")
for (const recipe of receitas.recipes ?? []) {
  console.log(`  ${recipe.id.slice(0, 8)}  ${recipe.name}  [${recipe.target}]  ${recipe.stepCount} passos`)
}

const gravada = (receitas.recipes ?? []).find((r) => r.name === "Minha receita")
if (!gravada) {
  console.log("\n✗ a receita não foi salva")
  await context.close()
  process.exit(1)
}

const detalhe = await panel.evaluate(
  async ([tk, id]) => {
    const r = await fetch(`http://127.0.0.1:7331/api/recipes/${id}`, {
      headers: { "X-Griver-Token": tk },
    })
    return await r.json()
  },
  [token, gravada.id],
)

const passos = detalhe.body?.steps ?? []
console.log(`passos gravados: ${passos.length}`)
for (const passo of passos) {
  console.log(`  ${passo.type} ${passo.target?.selectors?.[0] ?? passo.url ?? ""}`)
}

// ── 6. editar o JSON no painel e salvar ───────────────────────────────────
await panel.evaluate(() => {
  Array.from(document.querySelectorAll(".tab"))
    .find((t) => t.textContent?.includes("Receitas"))
    ?.click()
})
await panel.waitForTimeout(400)

const editou = await panel.evaluate(async () => {
  const editor = document.querySelector("textarea.code")
  if (!editor) return { ok: false, motivo: "sem editor" }
  const receita = JSON.parse(editor.value)
  receita.steps.push({ id: "espera-extra", type: "wait", ms: 50 })
  editor.value = JSON.stringify(receita, null, 2)
  editor.dispatchEvent(new Event("input", { bubbles: true }))
  await new Promise((r) => setTimeout(r, 100))
  const botao = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Salvar",
  )
  if (!botao) return { ok: false, motivo: "sem botão" }
  botao.click()
  await new Promise((r) => setTimeout(r, 900))
  return { ok: true, aviso: document.querySelector(".notice")?.textContent?.trim() }
})
console.log("9. edição pelo editor:", JSON.stringify(editou))

const aposEdicao = await panel.evaluate(
  async ([tk, id]) => {
    const r = await fetch(`http://127.0.0.1:7331/api/recipes/${id}`, {
      headers: { "X-Griver-Token": tk },
    })
    const body = await r.json()
    return body.body?.steps?.length ?? -1
  },
  [token, gravada.id],
)
console.log("10. passos após editar e salvar:", aposEdicao)

// ── 7. executar a receita na aba e conferir o resultado ───────────────────
await panel.evaluate(() => {
  Array.from(document.querySelectorAll(".tab"))
    .find((t) => t.textContent?.includes("Receitas"))
    ?.click()
})
await panel.waitForTimeout(400)
await page.bringToFront()
await panel.evaluate(() => {
  Array.from(document.querySelectorAll("button"))
    .find((b) => b.textContent?.trim() === "Executar aqui")
    ?.click()
})

let textoResultado = ""
for (let tentativa = 0; tentativa < 40; tentativa++) {
  await new Promise((r) => setTimeout(r, 500))
  textoResultado = await page
    .evaluate(() => document.querySelector("#resultado")?.textContent ?? "")
    .catch(() => "")
  if (textoResultado) break
}

console.log("resultado na página:", JSON.stringify(textoResultado))

// ── 8. limpeza: o teste não deixa lixo na base do usuário ─────────────────
await panel.evaluate(
  async ([tk, id]) => {
    await fetch(`http://127.0.0.1:7331/api/projects/${id}`, {
      method: "DELETE",
      headers: { "X-Griver-Token": tk },
    })
  },
  [token, idProjeto],
)

await context.close()
const ok = passos.length > 0 && aposEdicao === passos.length + 1 && textoResultado.includes("Vinicius")
console.log(ok ? "\n✓ receita salva e executada corretamente" : "\n✗ a receita não funcionou")
process.exit(ok ? 0 : 1)
