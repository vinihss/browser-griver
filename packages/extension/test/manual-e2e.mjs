import { chromium } from "playwright"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const extensionPath = resolve(process.argv[2] ?? "packages/extension/dist")
const serverUrl = process.argv[3] ?? "http://127.0.0.1:7331"
const targetUrl = process.argv[5] ?? "file:///tmp/opencode/teste.html"
/** token real, obtido da extensão depois de conectar */
let token = process.argv[4] ?? ""

const userDataDir = mkdtempSync(join(tmpdir(), "griver-chrome-"))

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

console.log("1. contexto aberto")

let worker = context.serviceWorkers()[0]
if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 })
console.log("2. service worker:", worker.url())

// as configurações podem ser semeadas pela página do painel
const panelUrl = `chrome-extension://${new URL(worker.url()).host}/panel.html`
const panel = await context.newPage()
await panel.goto(panelUrl)
// o painel é um módulo: espera o header existir antes de interagir
await panel.waitForSelector(".panel-header", { timeout: 15000 })
await panel.waitForTimeout(500)

await panel.evaluate(
  async ([url]) => {
    // o token é buscado pela extensão; aqui só apontamos o servidor
    await chrome.storage.local.set({ "griver.serverUrl": url })
  },
  [serverUrl],
)
console.log("3. configurações semeadas")

// reconecta pelo próprio painel (aba Ajustes)
await panel.evaluate(() => {
  document.querySelector('.panel-header button[title="Ajustes"]')?.click()
})
await panel.waitForTimeout(400)
await panel.evaluate(() => {
  Array.from(document.querySelectorAll("button"))
    .find((b) => b.textContent?.includes("Conectar"))
    ?.click()
})
await panel.waitForTimeout(2000)

const status = await panel.evaluate(() => document.querySelector(".status")?.textContent?.trim())
console.log("4. status no painel:", status)

// o token é obtido pela própria extensão ao conectar
token = await panel.evaluate(async () => {
  const guardado = await chrome.storage.local.get("griver.token")
  return guardado["griver.token"] ?? ""
})
console.log("   token em uso:", token ? `(${token.length} caracteres)` : "VAZIO")

// abre a página de teste
const page = await context.newPage()
await page.goto(targetUrl)
await page.waitForTimeout(600)

// o executor responde?
const probe = await worker.evaluate(async () => {
  const tabs = await chrome.tabs.query({})
  const target = tabs.find((t) => t.url?.includes("teste.html"))
  if (!target?.id) return { error: "aba não encontrada", tabs: tabs.map((t) => t.url) }
  try {
    const response = await chrome.tabs.sendMessage(target.id, {
      type: "griver:page",
      command: { action: "context" },
    })
    return { ok: true, titulo: response?.result?.title, elementos: response?.result?.elements?.length }
  } catch (error) {
    return { error: String(error) }
  }
})
console.log("5. contexto da página:", JSON.stringify(probe))

// liga a gravação pelo mesmo caminho que o botão do painel usa
await page.bringToFront()
const started = await panel.evaluate(async () => {
  const response = await chrome.runtime.sendMessage({ type: "panel:record", action: "start" })
  return response
})
console.log("6. gravação:", JSON.stringify(started))

// interage com a página
await page.click("#nome")
await page.fill("#nome", "Vinicius")
await page.selectOption("#plano", "pro")
await page.click("#enviar")
await page.waitForTimeout(1500)

const recorded = await worker.evaluate(async () => {
  const tabs = await chrome.tabs.query({})
  const target = tabs.find((t) => t.url?.includes("teste.html"))
  if (!target?.id) return { error: "aba não encontrada" }
  // o service worker guarda o estado; lê pelo painel
  return { ok: true }
})
console.log("7. interação concluída:", JSON.stringify(recorded))

// os eventos de gravação chegaram ao servidor?
const events = await panel.evaluate(async ([tk]) => {
  const response = await fetch("http://127.0.0.1:7331/api/recording", {
    headers: { "X-Griver-Token": tk },
  })
  return await response.text()
}, [token])
console.log("8. gravação no servidor:", events.slice(0, 700))

// 9. concludes a gravação e obtém a receita
const stopped = await panel.evaluate(async ([tk]) => {
  const response = await fetch("http://127.0.0.1:7331/api/recording/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Griver-Token": tk },
  })
  return await response.json()
}, [token])
console.log("9. receita gerada:", JSON.stringify(stopped.recipe, null, 1).slice(0, 900))

// 10. cria o projeto e salva a receita
const saved = await panel.evaluate(
  async ([tk, recipe]) => {
    const headers = { "Content-Type": "application/json", "X-Griver-Token": tk }
    const projectRes = await fetch("http://127.0.0.1:7331/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Teste e2e" }),
    })
    const project = (await projectRes.json()).project
    const recipeRes = await fetch("http://127.0.0.1:7331/api/recipes", {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectId: project.id,
        name: "Gravada",
        target: "browser",
        recipe,
      }),
    })
    return { project: project.id, recipe: await recipeRes.json() }
  },
  [token, stopped.recipe],
)
console.log("10. salvo:", JSON.stringify(saved).slice(0, 300))

// 11. executa a receita na aba
await page.bringToFront()
const executed = await panel.evaluate(async ([tk, recipeId]) => {
  await chrome.runtime.sendMessage({
    type: "panel:send",
    payload: { type: "run.start", recipeId, driver: "tab" },
  })
  return true
}, [token, saved.recipe.recipe.id])
console.log("11. execução disparada:", executed)

await page.waitForTimeout(3000)

// 12. o resultado da execução aparece no servidor
const runInfo = await panel.evaluate(async ([tk, recipeId]) => {
  const headers = { "Content-Type": "application/json", "X-Griver-Token": tk }
  const res = await fetch("http://127.0.0.1:7331/api/runs", {
    method: "POST",
    headers,
    body: JSON.stringify({ recipeId, driver: "tab" }),
  })
  const { runId } = await res.json()
  await new Promise((r) => setTimeout(r, 2500))
  const runRes = await fetch(`http://127.0.0.1:7331/api/runs/${runId}`, { headers })
  return await runRes.json()
}, [token, saved.recipe.recipe.id])
console.log("12. resultado:", JSON.stringify(runInfo).slice(0, 800))

// limpeza: o teste não deixa projeto nem receita na base do usuário
await panel.evaluate(
  async ([tk, projectId]) => {
    await fetch(`http://127.0.0.1:7331/api/projects/${projectId}`, {
      method: "DELETE",
      headers: { "X-Griver-Token": tk },
    })
  },
  [token, saved.project],
)

await context.close()
console.log("fim")
