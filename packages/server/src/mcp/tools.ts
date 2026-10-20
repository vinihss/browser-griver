/**
 * As ferramentas do Griver, expostas para o assistente.
 *
 * Cada uma é uma chamada à API do servidor: o assistente não mexe no banco
 * nem na aba — ele pede, e o servidor (e a extensão) fazem o trabalho.
 *
 * Todas passam pelas operações (`../ops.js`), a mesma camada que a linha
 * de comando usa: uma operação não pode ter dois jeitos de responder.
 */
import { GriverOps, type RecipeStepOp } from "../ops.js"

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

/** As operações do Griver — uma instância, compartilhada pelas ferramentas. */
const ops = new GriverOps()

/** Resposta em JSON, como o MCP espera. */
function json(valor: unknown): string {
  return JSON.stringify(valor, null, 2)
}

/** Lê um texto do input. */
function texto(entrada: Record<string, unknown>, chave: string): string {
  const valor = entrada[chave]
  return typeof valor === "string" ? valor : ""
}

/** Lê um texto do input ou falha. */
function textoObrigatorio(entrada: Record<string, unknown>, chave: string): string {
  const valor = texto(entrada, chave).trim()
  if (!valor) throw new Error(`${chave} é obrigatório`)
  return valor
}

/** Lê uma lista de seletores do input. */
function seletores(entrada: Record<string, unknown>, chave = "selectors"): string[] {
  const valor = entrada[chave]
  if (!Array.isArray(valor)) return []
  return valor.filter((item): item is string => typeof item === "string" && item.length > 0)
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
      const projetos = await ops.listProjects()
      const receitas = await ops.listRecipes(
        entrada.projectId ? String(entrada.projectId) : undefined,
      )
      return json({ projects: projetos.projects, recipes: receitas.recipes })
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
      return json(await ops.getRecipe(textoObrigatorio(entrada, "recipeId")))
    },
  },
  {
    name: "recipe_new",
    description: [
      "Cria uma receita nova, vazia, pronta para receber passos.",
      "Sem projectId, a receita entra no primeiro projeto do servidor.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nome da receita" },
        projectId: { type: "string", description: "Projeto da receita (opcional)" },
        target: { type: "string", enum: ["browser", "os"], description: "Alvo (padrão: browser)" },
        steps: {
          type: "array",
          items: PASSO,
          description: "Passos iniciais (opcional — vazio por padrão)",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async executar(entrada) {
      const nome = textoObrigatorio(entrada, "name")
      let projectId = texto(entrada, "projectId")
      if (!projectId) {
        const projetos = await ops.listProjects()
        const primeiro = projetos.projects[0]
        if (!primeiro) {
          throw new Error(
            "não há nenhum projeto no servidor — crie um com a ferramenta project_create",
          )
        }
        projectId = primeiro.id
      }
      const passos = Array.isArray(entrada.steps) ? entrada.steps : []
      const criado = await ops.createRecipe({
        projectId,
        name: nome,
        target: (texto(entrada, "target") || "browser") as "browser" | "os",
        recipe: {
          version: 1,
          steps: passos as never,
        },
      })
      return json({ recipe: criado.recipe, id: criado.recipe.id })
    },
  },
  {
    name: "recipe_update",
    description: "Muda o nome e/ou o alvo de uma receita, sem tocar nos passos.",
    inputSchema: {
      type: "object",
      properties: {
        recipeId: { type: "string" },
        name: { type: "string" },
        target: { type: "string", enum: ["browser", "os"] },
      },
      required: ["recipeId"],
      additionalProperties: false,
    },
    async executar(entrada) {
      const atualizado = await ops.updateRecipe(textoObrigatorio(entrada, "recipeId"), {
        ...(texto(entrada, "name") ? { name: texto(entrada, "name") } : {}),
        ...(texto(entrada, "target") ? { target: texto(entrada, "target") as "browser" | "os" } : {}),
      })
      return json({ recipe: atualizado.recipe })
    },
  },
  {
    name: "recipe_delete",
    description: "Apaga uma receita do servidor.",
    inputSchema: {
      type: "object",
      properties: { recipeId: { type: "string" } },
      required: ["recipeId"],
      additionalProperties: false,
    },
    async executar(entrada) {
      const id = textoObrigatorio(entrada, "recipeId")
      await ops.deleteRecipe(id)
      return json({ ok: true, deleted: id })
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
      const lista = (Array.isArray(entrada.ops) ? entrada.ops : []) as RecipeStepOp[]
      const resultado = await ops.patchRecipeSteps(
        textoObrigatorio(entrada, "recipeId"),
        lista,
        texto(entrada, "name") || undefined,
      )
      return json({
        recipe: resultado.recipe,
        steps: resultado.steps,
        issues: resultado.issues,
      })
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
      const id = textoObrigatorio(entrada, "recipeId")
      const atual = await ops.getRecipe(id)
      const alvo = (texto(entrada, "target") || atual.summary.target) as "browser" | "os"
      const problemas = await ops.validateRecipe(atual.body, alvo)
      return json({ target: alvo, issues: problemas.issues })
    },
  },
  {
    name: "recipe_history",
    description: "Lista as revisões de uma receita — cada alteração salva uma revisão.",
    inputSchema: {
      type: "object",
      properties: { recipeId: { type: "string" } },
      required: ["recipeId"],
      additionalProperties: false,
    },
    async executar(entrada) {
      return json(await ops.listRevisions(textoObrigatorio(entrada, "recipeId")))
    },
  },
  {
    name: "recipe_restore",
    description: "Restaura uma receita para uma revisão anterior.",
    inputSchema: {
      type: "object",
      properties: {
        recipeId: { type: "string" },
        revisionId: { type: "string" },
      },
      required: ["recipeId", "revisionId"],
      additionalProperties: false,
    },
    async executar(entrada) {
      const restaurado = await ops.restoreRevision(
        textoObrigatorio(entrada, "recipeId"),
        textoObrigatorio(entrada, "revisionId"),
      )
      return json({ recipe: restaurado.recipe })
    },
  },
  {
    name: "recipe_export",
    description:
      "Gera o código Playwright (alvo browser) ou Firecrawl (alvo os) de uma receita.",
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
      const gerado = await ops.compileRecipe(
        textoObrigatorio(entrada, "recipeId"),
        (texto(entrada, "target") || undefined) as "browser" | "os" | undefined,
      )
      return json(gerado)
    },
  },
  {
    name: "project_list",
    description: "Lista os projetos do servidor.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async executar() {
      return json(await ops.listProjects())
    },
  },
  {
    name: "project_create",
    description: "Cria um projeto novo.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async executar(entrada) {
      const criado = await ops.createProject({
        name: textoObrigatorio(entrada, "name"),
        ...(texto(entrada, "description") ? { description: texto(entrada, "description") } : {}),
      })
      return json({ project: criado.project })
    },
  },
  {
    name: "project_delete",
    description: "Apaga um projeto e as receitas que ele guarda.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
      additionalProperties: false,
    },
    async executar(entrada) {
      const id = textoObrigatorio(entrada, "projectId")
      await ops.deleteProject(id)
      return json({ ok: true, deleted: id })
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
      return json(await ops.pageContext())
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
      const alvo = { selectors: seletores(entrada) }
      if (!alvo.selectors.length) throw new Error("selectors é obrigatório")
      const textoAlternativo = texto(entrada, "text")
      const resultado = await ops.pageClick(
        textoAlternativo ? { ...alvo, text: textoAlternativo } : alvo,
      )
      return json(resultado)
    },
  },
  {
    name: "page_fill",
    description: "Preenche um campo da aba ativa. Requer aprovação do usuário.",
    inputSchema: {
      type: "object",
      properties: {
        selectors: {
          type: "array",
          items: { type: "string" },
          description: "Seletores CSS em ordem de preferência",
        },
        value: { type: "string", description: "Texto a preencher" },
      },
      required: ["selectors"],
      additionalProperties: false,
    },
    async executar(entrada) {
      const alvo = { selectors: seletores(entrada) }
      if (!alvo.selectors.length) throw new Error("selectors é obrigatório")
      return json(await ops.pageFill(alvo, texto(entrada, "value")))
    },
  },
  {
    name: "page_screenshot",
    description: "Captura a tela da aba ativa.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async executar() {
      return json(await ops.pageScreenshot())
    },
  },
  {
    name: "record_state",
    description:
      "Estado da gravação: idle, recording ou paused, com os passos capturados até agora.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async executar() {
      return json(await ops.recordingState())
    },
  },
  {
    name: "record_start",
    description: [
      "Começa a gravação na aba ativa do navegador.",
      "A partir daqui, toda interação na página vira passo da receita.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Projeto da receita (opcional)" },
      },
      additionalProperties: false,
    },
    async executar(entrada) {
      return json(
        await ops.recordStart(texto(entrada, "projectId") || undefined),
      )
    },
  },
  {
    name: "record_pause",
    description: "Pausa a captura: os eventos deixam de ser gravados.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async executar() {
      return json(await ops.recordPause())
    },
  },
  {
    name: "record_resume",
    description: "Retoma a captura.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async executar() {
      return json(await ops.recordResume())
    },
  },
  {
    name: "record_stop",
    description: [
      "Para a gravação e devolve a receita com os passos capturados.",
      "A receita não é salva: use recipe_new ou recipe_patch para guardá-la.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async executar() {
      return json(await ops.recordStop())
    },
  },
  {
    name: "record_discard",
    description: "Descarta a gravação: os passos capturados são perdidos.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async executar() {
      return json(await ops.recordDiscard())
    },
  },
  {
    name: "run",
    description:
      "Executa uma receita. driver=tab roda na aba ativa; playwright e firecrawl rodam no servidor.",
    inputSchema: {
      type: "object",
      properties: {
        recipeId: { type: "string" },
        driver: { type: "string", enum: ["tab", "playwright", "firecrawl"] },
        vars: { type: "object", description: "Variáveis da receita (opcional)" },
      },
      required: ["recipeId"],
      additionalProperties: false,
    },
    async executar(entrada) {
      const resultado = await ops.startRun({
        recipeId: textoObrigatorio(entrada, "recipeId"),
        driver: texto(entrada, "driver") || "tab",
        ...(entrada.vars ? { vars: entrada.vars as Record<string, unknown> } : {}),
      })
      return json(resultado)
    },
  },
  {
    name: "run_list",
    description: "Lista as execuções recentes.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async executar() {
      return json(await ops.listRuns())
    },
  },
  {
    name: "run_get",
    description: "Mostra uma execução e o log dela.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
    async executar(entrada) {
      return json(await ops.getRun(textoObrigatorio(entrada, "runId")))
    },
  },
  {
    name: "run_cancel",
    description: "Cancela uma execução em andamento.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
    async executar(entrada) {
      const id = textoObrigatorio(entrada, "runId")
      await ops.cancelRun(id)
      return json({ ok: true, cancelled: id })
    },
  },
  {
    name: "schedule_list",
    description: "Lista os agendamentos de execução.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async executar() {
      return json(await ops.listSchedules())
    },
  },
  {
    name: "schedule_add",
    description: "Agenda a execução de uma receita (cron de 5 campos).",
    inputSchema: {
      type: "object",
      properties: {
        recipeId: { type: "string" },
        cron: { type: "string", description: 'Expressão cron, ex.: "*/5 * * * *"' },
        driver: { type: "string", description: "Driver da execução (opcional)" },
      },
      required: ["recipeId", "cron"],
      additionalProperties: false,
    },
    async executar(entrada) {
      const criado = await ops.createSchedule({
        recipeId: textoObrigatorio(entrada, "recipeId"),
        cron: textoObrigatorio(entrada, "cron"),
        ...(texto(entrada, "driver") ? { driver: texto(entrada, "driver") } : {}),
      })
      return json({ schedule: criado.schedule })
    },
  },
  {
    name: "schedule_remove",
    description: "Remove um agendamento.",
    inputSchema: {
      type: "object",
      properties: { scheduleId: { type: "string" } },
      required: ["scheduleId"],
      additionalProperties: false,
    },
    async executar(entrada) {
      const id = textoObrigatorio(entrada, "scheduleId")
      await ops.deleteSchedule(id)
      return json({ ok: true, deleted: id })
    },
  },
]
