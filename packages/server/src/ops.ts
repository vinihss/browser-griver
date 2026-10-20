/**
 * Operações do Griver.
 *
 * Uma operação por ação do Griver, com o nome que o canal usa para
 * chamá-la. É a fonte única da semântica: o MCP e a linha de comando
 * chamam as mesmas funções, então não há dois jeitos de fazer a mesma
 * coisa — nem duas respostas diferentes para a mesma pergunta.
 *
 * Tudo passa pelo REST do servidor local: ele é o dono do estado
 * (receitas, execuções, gravação, aba). O cliente fala com o servidor;
 * o servidor fala com a extensão.
 */
import type {
  ProjectSummary,
  Recipe,
  RecipeSummary,
  RunSummary,
  TargetKind,
  ValidationIssue,
} from "@griver/core"
import { GriverRestClient, type RestOpcoes } from "./rest.js"

export interface Schedule {
  id: string
  recipeId: string
  cron: string
  driver: string
  enabled: boolean
  lastRunAt?: number
  createdAt: number
}

export interface RecipeRevision {
  id: string
  recipeId: string
  body: Recipe
  label: string | null
}

export interface RevisionSummary {
  id: string
  label: string | null
  createdAt: number
}

/** Estado da gravação no servidor. */
export interface RecordingSnapshot {
  id: string
  projectId?: string
  status: "idle" | "recording" | "paused"
  events: unknown[]
  startedAt: number
  updatedAt: number
}

/** Resposta de um comando de gravação. */
export interface RecordingCommandResult {
  snapshot: RecordingSnapshot
  /** o comando chegou em alguma extensão? */
  commanded: boolean
  /** a receita pronta — só no `stop` */
  recipe?: Recipe
}

/** Alvo de um elemento na página. */
export interface PageTarget {
  selectors: string[]
  text?: string
}

export interface PageContext {
  url: string
  title: string
  documento?: string
  elements?: unknown[]
}

/** Uma alteração na lista de passos de uma receita. */
export type RecipeStepOp =
  | { op: "add"; index?: number; step: Record<string, unknown> }
  | { op: "update"; index: number; step: Record<string, unknown> }
  | { op: "remove"; index: number }
  | { op: "move"; index: number; to: number }

export interface RecipeCreate {
  projectId?: string
  name: string
  target?: TargetKind
  recipe?: Recipe
}

export interface RecipePatch {
  name?: string
  target?: TargetKind
  recipe?: Recipe
}

/**
 * Cliente das operações do Griver.
 *
 * `new GriverOps()` fala com o servidor padrão; `new GriverOps({ baseUrl })`
 * com outro.
 */
export class GriverOps {
  readonly rest: GriverRestClient

  constructor(opcoes: RestOpcoes = {}) {
    this.rest = new GriverRestClient(opcoes)
  }

  // ── projetos ─────────────────────────────────────────────────────────────

  listProjects(): Promise<{ projects: ProjectSummary[] }> {
    return this.rest.api("/api/projects")
  }

  createProject(input: { name: string; description?: string }): Promise<{ project: ProjectSummary }> {
    return this.rest.api("/api/projects", { method: "POST", body: input })
  }

  updateProject(
    id: string,
    patch: { name?: string; description?: string },
  ): Promise<{ project: ProjectSummary }> {
    return this.rest.api(`/api/projects/${id}`, { method: "PATCH", body: patch })
  }

  deleteProject(id: string): Promise<{ ok: boolean }> {
    return this.rest.api(`/api/projects/${id}`, { method: "DELETE" })
  }

  // ── receitas ─────────────────────────────────────────────────────────────

  listRecipes(projectId?: string): Promise<{ recipes: RecipeSummary[] }> {
    const consulta = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""
    return this.rest.api(`/api/recipes${consulta}`)
  }

  getRecipe(id: string): Promise<{ summary: RecipeSummary; body: Recipe }> {
    return this.rest.api(`/api/recipes/${id}`)
  }

  createRecipe(input: RecipeCreate): Promise<{ recipe: RecipeSummary }> {
    return this.rest.api("/api/recipes", { method: "POST", body: input })
  }

  updateRecipe(id: string, patch: RecipePatch): Promise<{ recipe: RecipeSummary }> {
    return this.rest.api(`/api/recipes/${id}`, { method: "PATCH", body: patch })
  }

  deleteRecipe(id: string): Promise<{ ok: boolean }> {
    return this.rest.api(`/api/recipes/${id}`, { method: "DELETE" })
  }

  compileRecipe(
    id: string,
    target?: TargetKind,
  ): Promise<{ language: string; target: TargetKind; code: string }> {
    return this.rest.api(`/api/recipes/${id}/compile`, {
      method: "POST",
      body: target ? { target } : {},
    })
  }

  validateRecipe(recipe: Recipe, target: TargetKind): Promise<{ issues: ValidationIssue[] }> {
    return this.rest.api("/api/validate", { method: "POST", body: { recipe, target } })
  }

  listRevisions(id: string): Promise<{ revisions: RevisionSummary[] }> {
    return this.rest.api(`/api/recipes/${id}/revisions`)
  }

  getRevision(id: string, revisionId: string): Promise<{ revision: RecipeRevision }> {
    return this.rest.api(`/api/recipes/${id}/revisions/${revisionId}`)
  }

  restoreRevision(id: string, revisionId: string): Promise<{ recipe: RecipeSummary }> {
    return this.rest.api(`/api/recipes/${id}/revisions/${revisionId}/restore`, { method: "POST" })
  }

  /**
   * Aplica um lote de alterações na lista de passos.
   *
   * As operações são aplicadas sobre os passos atuais, nesta ordem:
   * `add`, `update`, `remove` e `move`. O passo novo ganha um id gerado
   * aqui — o mesmo que o editor do painel faz.
   */
  async patchRecipeSteps(
    id: string,
    ops: RecipeStepOp[],
    nome?: string,
  ): Promise<{ recipe: RecipeSummary; steps: number; issues: ValidationIssue[] }> {
    const atual = await this.getRecipe(id)
    const passos = [...atual.body.steps]

    for (const operacao of ops) {
      switch (operacao.op) {
        case "add": {
          const passo = {
            id: `s_${Math.random().toString(36).slice(2, 8)}`,
            ...(operacao.step as object),
          }
          const indice = typeof operacao.index === "number" ? operacao.index : passos.length
          passos.splice(indice, 0, passo as (typeof passos)[number])
          break
        }
        case "update": {
          if (!passos[operacao.index]) {
            throw new Error(`índice inválido para update: ${operacao.index}`)
          }
          passos[operacao.index] = {
            ...(passos[operacao.index] as object),
            ...(operacao.step as object),
          } as (typeof passos)[number]
          break
        }
        case "remove": {
          // índice fora do lugar é erro: senão o pedido some e quem pediu
          // acha que o passo foi removido
          if (typeof operacao.index !== "number" || !passos[operacao.index]) {
            throw new Error(`índice inválido para remove: ${operacao.index}`)
          }
          passos.splice(operacao.index, 1)
          break
        }
        case "move": {
          if (
            typeof operacao.index !== "number" ||
            typeof operacao.to !== "number" ||
            !passos[operacao.index]
          ) {
            throw new Error("move exige index e to")
          }
          const [movido] = passos.splice(operacao.index, 1)
          if (movido) passos.splice(operacao.to, 0, movido)
          break
        }
        default: {
          const desconhecida = operacao as { op?: string }
          throw new Error(`operação desconhecida: ${desconhecida.op}`)
        }
      }
    }

    const corpo = { ...atual.body, steps: passos }
    const atualizado = await this.updateRecipe(id, {
      ...(nome ? { name: nome } : {}),
      recipe: corpo,
    })
    const problemas = await this.validateRecipe(corpo, atual.summary.target)

    return { recipe: atualizado.recipe, steps: passos.length, issues: problemas.issues }
  }

  // ── execuções ────────────────────────────────────────────────────────────

  listRuns(): Promise<{ runs: RunSummary[] }> {
    return this.rest.api("/api/runs")
  }

  getRun(id: string): Promise<{ run: RunSummary; log: unknown }> {
    return this.rest.api(`/api/runs/${id}`)
  }

  startRun(input: {
    recipeId: string
    driver?: string
    vars?: Record<string, unknown>
  }): Promise<{ runId: string }> {
    return this.rest.api("/api/runs", { method: "POST", body: input })
  }

  cancelRun(id: string): Promise<{ ok: boolean }> {
    return this.rest.api(`/api/runs/${id}/cancel`, { method: "POST" })
  }

  // ── agendamentos ─────────────────────────────────────────────────────────

  listSchedules(): Promise<{ schedules: Schedule[] }> {
    return this.rest.api("/api/schedules")
  }

  createSchedule(input: {
    recipeId: string
    cron: string
    driver?: string
  }): Promise<{ schedule: Schedule }> {
    return this.rest.api("/api/schedules", { method: "POST", body: input })
  }

  deleteSchedule(id: string): Promise<{ ok: boolean }> {
    return this.rest.api(`/api/schedules/${id}`, { method: "DELETE" })
  }

  // ── gravação ─────────────────────────────────────────────────────────────

  recordingState(): Promise<RecordingSnapshot> {
    return this.rest.api("/api/recording")
  }

  recordStart(projectId?: string): Promise<RecordingCommandResult> {
    return this.rest.api("/api/recording/start", {
      method: "POST",
      body: projectId ? { projectId } : {},
    })
  }

  recordPause(): Promise<RecordingCommandResult> {
    return this.rest.api("/api/recording/pause", { method: "POST" })
  }

  recordResume(): Promise<RecordingCommandResult> {
    return this.rest.api("/api/recording/resume", { method: "POST" })
  }

  recordStop(): Promise<RecordingCommandResult> {
    return this.rest.api("/api/recording/stop", { method: "POST" })
  }

  recordDiscard(): Promise<RecordingCommandResult> {
    return this.rest.api("/api/recording/discard", { method: "POST" })
  }

  // ── página ───────────────────────────────────────────────────────────────

  pageContext(): Promise<PageContext> {
    return this.rest.api("/api/page/context", { method: "POST" })
  }

  pageClick(target: PageTarget): Promise<unknown> {
    return this.rest.api("/api/page/click", { method: "POST", body: { target } })
  }

  pageFill(target: PageTarget, value: string): Promise<unknown> {
    return this.rest.api("/api/page/fill", { method: "POST", body: { target, value } })
  }

  pageScreenshot(): Promise<{ dataUrl?: string; ok?: boolean }> {
    return this.rest.api("/api/page/screenshot", { method: "POST" })
  }

  // ── conversas ────────────────────────────────────────────────────────────

  listChatSessions(): Promise<{ sessions: { id: string; title: string; createdAt: number }[] }> {
    return this.rest.api("/api/chat/sessions")
  }

  createChatSession(input: { projectId?: string; title?: string }): Promise<{ session: unknown }> {
    return this.rest.api("/api/chat/sessions", { method: "POST", body: input })
  }

  chatMessages(id: string): Promise<{ messages: unknown[] }> {
    return this.rest.api(`/api/chat/sessions/${id}/messages`)
  }

  chatPrompt(id: string, text: string): Promise<unknown> {
    return this.rest.api(`/api/chat/sessions/${id}/prompt`, { method: "POST", body: { text } })
  }

  chatInterrupt(id: string): Promise<unknown> {
    return this.rest.api(`/api/chat/sessions/${id}/interrupt`, { method: "POST" })
  }

  // ── servidor ─────────────────────────────────────────────────────────────

  health(): Promise<{ ok: boolean; version?: string }> {
    return this.rest.api("/api/health")
  }

  info(): Promise<Record<string, unknown>> {
    return this.rest.api("/api/info")
  }
}
