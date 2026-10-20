/**
 * Plugin do OpenCode para o Griver.
 *
 * Registra as ferramentas `griver_*`, que permitem ao assistente:
 *  - ler e editar receitas (AST) pela API REST do servidor local;
 *  - inspecionar a aba ativa do navegador;
 *  - agir na aba (clicar, preencher) mediante aprovação do usuário;
 *  - disparar execuções.
 *
 * As ações que tocam o browser passam por `ctx.permission.assert`, então o
 * usuário aprova cada uma no painel da extensão.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

let Plugin
try {
  Plugin = (await import("@opencode/plugin")).Plugin
} catch {
  // o pacote não está resolvível a partir do projeto — o loader do OpenCode
  // aceita o objeto puro
  Plugin = { define: (value) => value }
}

const SERVER_URL = process.env.GRIVER_SERVER_URL ?? "http://127.0.0.1:7331"

/** Resolve o token de acesso a partir da pasta de dados do projeto. */
function readToken(directory) {
  const candidates = [
    process.env.GRIVER_TOKEN,
    directory ? join(directory, "data", "token") : undefined,
    join(process.cwd(), "data", "token"),
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const value = readFileSync(candidate, "utf8").trim()
      if (value) return value
    } catch {
      // tenta o próximo
    }
  }
  return ""
}

let cachedToken = ""
let cachedDirectory = ""

async function api(path, options = {}) {
  const directory = process.env.GRIVER_PROJECT_DIR ?? cachedDirectory
  if (directory !== cachedDirectory) {
    cachedDirectory = directory
    cachedToken = ""
  }
  if (!cachedToken) cachedToken = readToken(directory)

  let response = await fetch(`${SERVER_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Griver-Token": cachedToken,
      ...(options.headers ?? {}),
    },
  })

  // o servidor pode ter sido reiniciado com outro token — relê e tenta de novo
  if (response.status === 401 && !options.__retried) {
    cachedToken = readToken(directory)
    response = await fetch(`${SERVER_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-Griver-Token": cachedToken,
        ...(options.headers ?? {}),
      },
    })
  }
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = text
  }
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        "Token inválido ao falar com o Griver. O token esperado fica em " +
          "<projeto>/data/token — reinicie o servidor com `griver serve` a partir da pasta do projeto " +
          "ou exporte GRIVER_TOKEN com o valor correto.",
      )
    }
    if (response.status === 502) {
      throw new Error(
        "A extensão do Griver não respondeu. Abra o Chrome com a extensão carregada e a aba que você quer controlar.",
      )
    }
    throw new Error(body?.error ?? `Griver respondeu HTTP ${response.status}`)
  }
  return body
}

/** Ferramentas registradas no plugin. */
function tools(ctx) {
  const directory = ctx.location?.directory

  const permission = async (context, action, resources) => {
    await ctx.permission.assert({
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
      action,
      resources,
      save: [],
    })
  }

  return [
    {
      name: "griver_recipe_list",
      description:
        "Lista os projetos e receitas de automação do Griver. Use para descobrir ids antes de editar.",
      input: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Filtra por projeto (opcional)" },
        },
        additionalProperties: false,
      },
      options: { namespace: "griver" },
      execute: async (input) => {
        const projects = await api("/api/projects")
        const recipes = await api(
          input.projectId ? `/api/recipes?projectId=${encodeURIComponent(input.projectId)}` : "/api/recipes",
        )
        return {
          content: JSON.stringify({ projects: projects.projects, recipes: recipes.recipes }, null, 2),
        }
      },
    },
    {
      name: "griver_recipe_get",
      description: "Lê uma receita completa (passos em JSON) pelo id.",
      input: {
        type: "object",
        properties: { recipeId: { type: "string" } },
        required: ["recipeId"],
        additionalProperties: false,
      },
      options: { namespace: "griver" },
      execute: async (input) => {
        const recipe = await api(`/api/recipes/${input.recipeId}`)
        return { content: JSON.stringify(recipe, null, 2) }
      },
    },
    {
      name: "griver_recipe_patch",
      description: [
        "Edita uma receita: adiciona, altera, remove ou move passos.",
        "Operações: add (index opcional), update (step substitui o passo), remove (index), move (de/para).",
        "Exemplo de step: {\"type\":\"extract\",\"target\":{\"selectors\":[\".preco\"]},\"saveAs\":\"preco\"}",
      ].join(" "),
      input: {
        type: "object",
        properties: {
          recipeId: { type: "string" },
          ops: {
            type: "array",
            items: {
              type: "object",
              properties: {
                op: { type: "string", enum: ["add", "update", "remove", "move"] },
                index: { type: "number" },
                to: { type: "number" },
                step: { type: "object" },
              },
              required: ["op"],
              additionalProperties: false,
            },
          },
          name: { type: "string", description: "Novo nome da receita (opcional)" },
        },
        required: ["recipeId", "ops"],
        additionalProperties: false,
      },
      options: { namespace: "griver" },
      execute: async (input) => {
        const current = await api(`/api/recipes/${input.recipeId}`)
        const steps = [...current.body.steps]

        for (const op of input.ops) {
          switch (op.op) {
            case "add": {
              const step = { id: `s_${Math.random().toString(36).slice(2, 8)}`, ...op.step }
              const index = typeof op.index === "number" ? op.index : steps.length
              steps.splice(index, 0, step)
              break
            }
            case "update": {
              if (typeof op.index !== "number" || !steps[op.index]) {
                throw new Error(`índice inválido para update: ${op.index}`)
              }
              steps[op.index] = { ...steps[op.index], ...op.step }
              break
            }
            case "remove": {
              if (typeof op.index !== "number" || !steps[op.index]) {
                throw new Error(`índice inválido para remove: ${op.index}`)
              }
              steps.splice(op.index, 1)
              break
            }
            case "move": {
              if (typeof op.index !== "number" || typeof op.to !== "number") {
                throw new Error("move exige index e to")
              }
              const [moved] = steps.splice(op.index, 1)
              steps.splice(op.to, 0, moved)
              break
            }
          }
        }

        const body = { ...current.body, steps }
        const updated = await api(`/api/recipes/${input.recipeId}`, {
          method: "PATCH",
          body: JSON.stringify({
            ...(input.name ? { name: input.name } : {}),
            recipe: body,
          }),
        })

        const issues = await api("/api/validate", {
          method: "POST",
          body: JSON.stringify({ recipe: body, target: current.summary.target }),
        })

        return {
          content: JSON.stringify(
            { recipe: updated.recipe, steps: body.steps.length, issues: issues.issues },
            null,
            2,
          ),
        }
      },
    },
    {
      name: "griver_page_context",
      description:
        "Inspeciona a aba ativa do navegador: URL, título e elementos interativos com seus seletores.",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { namespace: "griver" },
      execute: async () => {
        const context = await api("/api/page/context", { method: "POST" })
        return { content: JSON.stringify(context, null, 2) }
      },
    },
    {
      name: "griver_page_click",
      description: "Clica em um elemento da aba ativa. Requer aprovação do usuário.",
      input: {
        type: "object",
        properties: {
          selectors: {
            type: "array",
            items: { type: "string" },
            description: "Seletores CSS em ordem de preferência",
          },
          text: { type: "string", description: "Texto alternativo do elemento" },
        },
        required: ["selectors"],
        additionalProperties: false,
      },
      options: { namespace: "griver" },
      execute: async (input, context) => {
        const target = { selectors: input.selectors, ...(input.text ? { text: input.text } : {}) }
        await permission(context, "browser.click", input.selectors)
        const result = await api("/api/page/click", {
          method: "POST",
          body: JSON.stringify({ target }),
        })
        return { content: JSON.stringify(result) }
      },
    },
    {
      name: "griver_page_fill",
      description: "Preenche um campo da aba ativa. Requer aprovação do usuário.",
      input: {
        type: "object",
        properties: {
          selectors: { type: "array", items: { type: "string" } },
          value: { type: "string" },
        },
        required: ["selectors", "value"],
        additionalProperties: false,
      },
      options: { namespace: "griver" },
      execute: async (input, context) => {
        await permission(context, "browser.fill", input.selectors)
        const result = await api("/api/page/fill", {
          method: "POST",
          body: JSON.stringify({ target: { selectors: input.selectors }, value: input.value }),
        })
        return { content: JSON.stringify(result) }
      },
    },
    {
      name: "griver_run",
      description:
        "Executa uma receita. driver=tab roda na aba ativa; driver=playwright ou firecrawl roda no servidor.",
      input: {
        type: "object",
        properties: {
          recipeId: { type: "string" },
          driver: { type: "string", enum: ["tab", "playwright", "firecrawl"] },
        },
        required: ["recipeId"],
        additionalProperties: false,
      },
      options: { namespace: "griver" },
      execute: async (input) => {
        const result = await api("/api/runs", {
          method: "POST",
          body: JSON.stringify({ recipeId: input.recipeId, driver: input.driver ?? "tab" }),
        })
        return { content: JSON.stringify(result) }
      },
    },
    {
      name: "griver_validate",
      description: "Valida uma receita para um alvo (browser ou os) e aponta passos incompatíveis.",
      input: {
        type: "object",
        properties: {
          recipeId: { type: "string" },
          target: { type: "string", enum: ["browser", "os"] },
        },
        required: ["recipeId"],
        additionalProperties: false,
      },
      options: { namespace: "griver" },
      execute: async (input) => {
        const current = await api(`/api/recipes/${input.recipeId}`)
        const target = input.target ?? current.summary.target
        const issues = await api("/api/validate", {
          method: "POST",
          body: JSON.stringify({ recipe: current.body, target }),
        })
        return { content: JSON.stringify({ target, issues: issues.issues }, null, 2) }
      },
    },
  ]
}

export default Plugin.define({
  id: "griver",
  async setup(ctx) {
    // a pasta do projeto é onde o token do Griver mora (data/token)
    if (ctx.location?.directory) cachedDirectory = ctx.location.directory

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "griver",
        description: "Ferramentas do Griver: receitas de automação e controle do navegador",
      })
      for (const definition of tools(ctx)) {
        editor.add(definition)
      }
    })
  },
})
