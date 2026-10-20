/**
 * Teste de integração do chat com o assistente de IA.
 *
 * Sobe o servidor, cria uma receita e pede ao assistente para alterá-la,
 * conferindo se a ferramenta `griver_recipe_patch` foi realmente usada.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { startServer } from "../dist/index.js"

/**
 * O plugin do OpenCode lê o token em `<projeto>/data/token` e fala com
 * `http://127.0.0.1:7331` — por isso o teste usa a pasta de dados e a porta
 * reais do projeto, e não uma temporária.
 */
const dataDir = resolve("data")
const port = 7331
const server = await startServer({ dataDir, port, token: undefined })
const base = server.url
const headers = { "Content-Type": "application/json", "X-Griver-Token": server.config.token }

const call = async (path, init = {}) => {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path} → ${response.status}: ${text}`)
  return text ? JSON.parse(text) : undefined
}

// ── 준비 ──
const { project } = await call("/api/projects", {
  method: "POST",
  body: JSON.stringify({ name: "Chat" }),
})

const recipeBody = {
  version: 1,
  steps: [
    { id: "s1", type: "navigate", url: "https://exemplo.com" },
    { id: "s2", type: "click", target: { selectors: ["#comprar"] } },
  ],
}

const { recipe } = await call("/api/recipes", {
  method: "POST",
  body: JSON.stringify({ projectId: project.id, name: "Comprar", target: "browser", recipe: recipeBody }),
})
console.log("receita criada:", recipe.id, "com", recipe.stepCount, "passos")

// ── conversa ──
const { session } = await call("/api/chat/sessions", {
  method: "POST",
  body: JSON.stringify({ projectId: project.id, title: "Teste de chat" }),
})
console.log("sessão criada:", session.id)

const eventos = []
await call(`/api/chat/sessions/${session.id}/prompt`, {
  method: "POST",
  body: JSON.stringify({
    text:
      `Use as ferramentas do Griver. A receita ${recipe.id} deve ganhar um passo ` +
      `extract no seletor ".preco" salvando em "preco". Aplique a alteração com griver_recipe_patch.`,
  }),
})

// aguarda a execução terminar
const deadline = Date.now() + 180_000
let ultimoTexto = ""
let concluiu = false
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1500))
  const status = await call(`/api/chat/sessions/${session.id}`)
  const messages = await call(`/api/chat/sessions/${session.id}/messages`)
  const lista = messages.messages ?? []
  const assistente = lista.filter((m) => m.type === "assistant")
  if (assistente.length) {
    const conteudo = assistente[assistente.length - 1]?.content ?? []
    ultimoTexto = conteudo
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join(" ")
  }
  // a execução acabou quando não está mais em andamento e houve resposta
  if (!status.executing && assistente.length && lista.some((m) => m.type === "assistant")) {
    // dá um respiro para a última tool call ser aplicada
    await new Promise((r) => setTimeout(r, 2500))
    concluiu = true
    break
  }
}
console.log("execução concluída:", concluiu)

// ── resultado ──
const final = await call(`/api/recipes/${recipe.id}`)
console.log("\nreceita final:")
console.log(JSON.stringify(final.body, null, 2))

const extraiu = final.body.steps.some(
  (step) => step.type === "extract" && step.saveAs === "preco",
)
console.log("\npasso de extract adicionado:", extraiu ? "SIM" : "NÃO")
console.log("última mensagem do assistente:", ultimoTexto.slice(0, 300))

await server.close()
process.exit(extraiu ? 0 : 1)
