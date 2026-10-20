/**
 * As ferramentas do Griver, expostas para o assistente.
 *
 * Cada uma é uma chamada à API do servidor: o assistente não mexe no banco
 * nem na aba — ele pede, e o servidor (e a extensão) fazem o trabalho.
 */
import { api } from "./client.js"

/** Uma ferramenta do Griver. */
export interface Ferramenta {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
  executar(entrada: Record<string, unknown>): Promise<string>
}

/** O formato do passo de uma receita, para o modelo saber o que enviar. */
const PASSO = {
  type: "object",
  description:
    'Passo da receita. Exemplo: {"type":"extract","target":{"selectors":[".preco"]},"saveAs":"preco"}',
}

export const ferramentas: Ferramenta[] = [
  {
    name: "recipe_list",
    description:
      "Lista os projetos e receitas de automação do Griver. Use para descobrir ids antes de editar.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Filtra por projeto (opcional)" },
      },
      additionalProperties: false,
    },
    async executar(entrada) {
      const projetos = await api<{ projects: unknown[] }>("/api/projects")
      const receitas = await api<{ recipes: unknown[] }>(
        entrada.projectId
          ? `/api/recipes?projectId=${encodeURIComponent(String(entrada.projectId))}`
          : "/api/recipes",
      )
      return JSON.stringify({ projects: projetos.projects, recipes: receitas.recipes }, null, 2)
    },
  },
  {
    name: "recipe_get",
    description: "Lê uma receita completa (passos em JSON) pelo id.",
    inputSchema: {
      type: "object",
      properties: { recipeId: { type: "string" } },
      required: ["recipeId"],
      additionalProperties: false,
    },
    async executar(entrada) {
      const receita = await api(`/api/recipes/${entrada.recipeId}`)
      return JSON.stringify(receita, null, 2)
    },
  },
  {
    name: "recipe_patch",
    description: [
      "Edita uma receita: adiciona, altera, remove ou move passos.",
      "Operações: add (index opcional), update (index substitui o passo), remove (index), move (de/para).",
      'Exemplo de step: {"type":"extract","target":{"selectors":[".preco"]},"saveAs":"preco"}',
    ].join(" "),
    inputSchema: {
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
              step: PASSO,
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
    async executar(entrada) {
      const atual = await api<{ body: { steps: unknown[] }; summary: { target: string } }>(
        `/api/recipes/${entrada.recipeId}`,
      )
      const passos = [...atual.body.steps]

      for (const operacao of (entrada.ops as { op: string; index?: number; to?: number; step?: unknown }[]) ?? []) {
        switch (operacao.op) {
          case "add": {
            const passo = { id: `s_${Math.random().toString(36).slice(2, 8)}`, ...(operacao.step as object) }
            const indice = typeof operacao.index === "number" ? operacao.index : passos.length
            passos.splice(indice, 0, passo)
            break
          }
          case "update": {
            if (typeof operacao.index !== "number" || !passos[operacao.index]) {
              throw new Error(`índice inválido para update: ${operacao.index}`)
            }
            passos[operacao.index] = { ...(passos[operacao.index] as object), ...(operacao.step as object) }
            break
          }
          case "remove": {
            if (typeof operacao.index !== "number") {
              throw new Error(`índice inválido para remove: ${operacao.index}`)
            }
            passos.splice(operacao.index, 1)
            break
          }
          case "move": {
            if (typeof operacao.index !== "number" || typeof operacao.to !== "number") {
              throw new Error("move exige index e to")
            }
            const [movido] = passos.splice(operacao.index, 1)
            passos.splice(operacao.to, 0, movido)
            break
          }
          default:
            throw new Error(`operação desconhecida: ${operacao.op}`)
        }
      }

      const corpo = { ...atual.body, steps: passos }
      const atualizado = await api<{ recipe: unknown }>(`/api/recipes/${entrada.recipeId}`, {
        method: "PATCH",
        body: {
          ...(entrada.name ? { name: entrada.name } : {}),
          recipe: corpo,
        },
      })

      const problemas = await api<{ issues: unknown[] }>("/api/validate", {
        method: "POST",
        body: { recipe: corpo, target: atual.summary.target },
      })

      return JSON.stringify(
        { recipe: atualizado.recipe, steps: passos.length, issues: problemas.issues },
        null,
        2,
      )
    },
  },
  {
    name: "recipe_validate",
    description: "Valida uma receita para um alvo (browser ou os) e aponta passos incompatíveis.",
    inputSchema: {
      type: "object",
      properties: {
        recipeId: { type: "string" },
        target: { type: "string", enum: ["browser", "os"] },
      },
      required: ["recipeId"],
      additionalProperties: false,
    },
    async executar(entrada) {
      const atual = await api<{ body: unknown; summary: { target: string } }>(
        `/api/recipes/${entrada.recipeId}`,
      )
      const alvo = entrada.target ?? atual.summary.target
      const problemas = await api<{ issues: unknown[] }>("/api/validate", {
        method: "POST",
        body: { recipe: atual.body, target: alvo },
      })
      return JSON.stringify({ target: alvo, issues: problemas.issues }, null, 2)
    },
  },
  {
    name: "page_context",
    description:
      "Inspeciona a aba ativa do navegador: URL, título e elementos interativos com seus seletores.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async executar() {
      const contexto = await api("/api/page/context", { method: "POST" })
      return JSON.stringify(contexto, null, 2)
    },
  },
  {
    name: "page_click",
    description: "Clica em um elemento da aba ativa. Requer aprovação do usuário.",
    inputSchema: {
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
    async executar(entrada) {
      const seletores = entrada.selectors as string[]
      const alvo = { selectors: seletores, ...(entrada.text ? { text: entrada.text } : {}) }
      const resultado = await api("/api/page/click", { method: "POST", body: { target: alvo } })
      return JSON.stringify(resultado)
    },
  },
  {
    name: "page_fill",
    description: "Preenche um campo da aba ativa. Requer aprovação do usuário.",
    inputSchema: {
      type: "object",
      properties: {
        selectors: { type: "array", items: { type: "string" } },
        value: { type: "string" },
      },
      required: ["selectors", "value"],
      additionalProperties: false,
    },
    async executar(entrada) {
      const resultado = await api("/api/page/fill", {
        method: "POST",
        body: {
          target: { selectors: entrada.selectors as string[] },
          value: entrada.value,
        },
      })
      return JSON.stringify(resultado)
    },
  },
  {
    name: "run",
    description:
      "Executa uma receita. driver=tab roda na aba ativa; driver=playwright ou firecrawl roda no servidor.",
    inputSchema: {
      type: "object",
      properties: {
        recipeId: { type: "string" },
        driver: { type: "string", enum: ["tab", "playwright", "firecrawl"] },
      },
      required: ["recipeId"],
      additionalProperties: false,
    },
    async executar(entrada) {
      const resultado = await api("/api/runs", {
        method: "POST",
        body: { recipeId: entrada.recipeId, driver: entrada.driver ?? "tab" },
      })
      return JSON.stringify(resultado)
    },
  },
]

/** As ferramentas por nome. */
export function ferramentaPorNome(nome: string): Ferramenta | undefined {
  return ferramentas.find((ferramenta) => ferramenta.name === nome)
}
