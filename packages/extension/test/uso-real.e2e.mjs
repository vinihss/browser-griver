/**
 * Cobre os três relatos do usuário:
 *
 *  1. executar uma receita na aba (navegação + passos);
 *  2. a lista de projetos aparecer sozinha ao abrir o painel;
 *  3. a primeira mensagem do chat não ser engolida pela criação da sessão.
 */
import { chromium } from "playwright"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const extensionPath = resolve("packages/extension/dist")
const serverUrl = process.argv[2] ?? "http://127.0.0.1:7331"
const targetUrl = process.argv[3] ?? "file:///tmp/opencode/teste.html"

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "griver-uso-")), {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
  ],
})

let worker = context.serviceWorkers()[0]
if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 })

// a extensão já conecta sozinha; basta apontar o servidor
const panel = await context.newPage()
await panel.goto(`chrome-extension://${new URL(worker.url()).host}/panel.html`)
await panel.evaluate(async ([url]) => {
  await chrome.storage.local.set({ "griver.serverUrl": url })
}, [serverUrl])
await panel.reload()
await panel.waitForTimeout(2500)

const token = await panel.evaluate(async () => {
  const guardado = await chrome.storage.local.get("griver.token")
  return guardado["griver.token"] ?? ""
})
const api = async (path, init) =>
  panel.evaluate(
    async ([tk, p, i]) => {
      const r = await fetch(`http://127.0.0.1:7331${p}`, {
        ...(i ?? {}),
        headers: { "Content-Type": "application/json", "X-Griver-Token": tk },
      })
      return { status: r.status, body: await r.json().catch(() => null) }
    },
    [token, path, init],
  )

// ── 1. projetos aparecem sozinhos ─────────────────────────────────────────
const anotados = await panel.evaluate(() => document.querySelectorAll(".list-item-title").length)
console.log("1. projetos listados ao abrir o painel:", anotados)

// ── 2. gravar e executar ──────────────────────────────────────────────────
const projeto = (await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Teste uso" }) }))
  .body.project
await panel.evaluate(async () => {
  await chrome.runtime.sendMessage({ type: "panel:status" })
})
await panel.reload()
await panel.waitForTimeout(1800)

const page = await context.newPage()
await page.goto(targetUrl)
await page.waitForTimeout(500)

const receita = (
  await api("/api/recipes", {
    method: "POST",
    body: JSON.stringify({
      projectId: projeto.id,
      name: "Fluxo",
      target: "browser",
      recipe: {
        version: 1,
        steps: [
          { id: "n1", type: "navigate", url: targetUrl },
          { id: "f1", type: "fill", target: { selectors: ["#nome"] }, value: "Maria" },
          { id: "s1", type: "select", target: { selectors: ["#plano"] }, value: "pro" },
          { id: "c1", type: "click", target: { selectors: ["#enviar"] } },
        ],
      },
    }),
  })
).body.recipe

await page.bringToFront()
// executa pela UI, como o usuário faz
await panel.evaluate(
  async ([id]) => {
    Array.from(document.querySelectorAll(".tab"))
      .find((t) => t.textContent?.includes("Receitas"))
      ?.click()
    await new Promise((r) => setTimeout(r, 600))
    // seleciona a receita na lista
    const itens = Array.from(document.querySelectorAll(".list-item-main"))
    const alvo = itens.find((b) => b.textContent?.includes("Fluxo"))
    alvo?.click()
    await new Promise((r) => setTimeout(r, 800))
    Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent?.trim() === "Executar aqui")
      ?.click()
    return id
  },
  [receita.id],
)

let resultado = ""
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500))
  resultado = await page.evaluate(() => document.querySelector("#resultado")?.textContent ?? "").catch(() => "")
  if (resultado) break
}

const runs = (await api("/api/runs")).body.runs
const ultimo = runs.find((r) => r.recipeId === receita.id)
console.log("2. execução:", ultimo?.status, "| erro:", ultimo?.error ?? "nenhum")
console.log("   resultado na página:", JSON.stringify(resultado))

// ── 3. primeira mensagem do chat ──────────────────────────────────────────
await panel.bringToFront()
await panel.evaluate(async () => {
  // começa sem sessão, como um painel recém-aberto
  Array.from(document.querySelectorAll(".tab"))
    .find((t) => t.textContent?.includes("Chat"))
    ?.click()
  await new Promise((r) => setTimeout(r, 400))
  const campo = document.querySelector(".chat-input")
  campo.value = "qual é o próximo passo?"
  campo.dispatchEvent(new Event("input", { bubbles: true }))
  Array.from(document.querySelectorAll("button"))
    .find((b) => b.textContent?.trim() === "Enviar")
    ?.click()
})
await panel.waitForTimeout(6000)

const bolhas = await panel.evaluate(() =>
  Array.from(document.querySelectorAll(".chat-msg")).map((b) => b.textContent?.trim()),
)
console.log("3. mensagens no chat:", JSON.stringify(bolhas.slice(0, 4)))

const enviou = bolhas.some((b) => b?.includes("próximo passo"))
const respondeu = bolhas.some((b) => b?.includes("assistente") || b?.includes("sistema"))

// limpeza
await api(`/api/projects/${projeto.id}`, { method: "DELETE" })
await context.close()

console.log(`\nprojetos: ${anotados > 0 ? "ok" : "FALHOU"}`)
console.log(`execução: ${ultimo?.status === "ok" ? "ok" : "FALHOU"}`)
console.log(`chat: ${enviou ? "mensagem não se perdeu" : "FALHOU"} / ${respondeu ? "respondeu" : "sem resposta (verifique o OpenCode)"}`)

process.exit(anotados > 0 && ultimo?.status === "ok" && enviou ? 0 : 1)
