import { randomUUID } from "node:crypto"
import type { Recipe, TargetKind } from "@griver/core"
import type { Db } from "./index.js"
import type { ProjectSummary, RecipeSummary, RunSummary } from "@griver/core"

interface ProjectRow {
  id: string
  name: string
  description: string | null
  created_at: number
  updated_at: number
}

interface RecipeRow {
  id: string
  project_id: string
  name: string
  target: string
  body: string
  created_at: number
  updated_at: number
}

interface RunRow {
  id: string
  recipe_id: string | null
  recipe_name: string | null
  driver: string
  status: string
  started_at: number
  ended_at: number | null
  error: string | null
  scope: string | null
  log: string
}

export class Repository {
  constructor(private readonly db: Db) {}

  // ── projetos ──────────────────────────────────────────────────────────────

  listProjects(): ProjectSummary[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM recipes r WHERE r.project_id = p.id) AS recipe_count
         FROM projects p ORDER BY p.updated_at DESC`,
      )
      .all() as unknown as (ProjectRow & { recipe_count: number })[]

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      recipeCount: Number(row.recipe_count),
    }))
  }

  getProject(id: string): ProjectSummary | undefined {
    const row = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as unknown as
      | ProjectRow
      | undefined
    if (!row) return undefined
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  createProject(name: string, description?: string): ProjectSummary {
    const now = Date.now()
    const id = randomUUID()
    this.db
      .prepare(`INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, name, description ?? null, now, now)
    return {
      id,
      name,
      description: description ?? null,
      createdAt: now,
      updatedAt: now,
      recipeCount: 0,
    }
  }

  updateProject(id: string, patch: { name?: string; description?: string | null }): ProjectSummary | undefined {
    const existing = this.getProject(id)
    if (!existing) return undefined
    const name = patch.name ?? existing.name
    const description = patch.description === undefined ? existing.description : patch.description
    this.db
      .prepare(`UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?`)
      .run(name, description, Date.now(), id)
    return this.getProject(id)
  }

  deleteProject(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id)
    return Number(result.changes) > 0
  }

  // ── receitas ──────────────────────────────────────────────────────────────

  listRecipes(projectId?: string): RecipeSummary[] {
    const rows = (
      projectId
        ? this.db.prepare(`SELECT * FROM recipes WHERE project_id = ? ORDER BY updated_at DESC`).all(projectId)
        : this.db.prepare(`SELECT * FROM recipes ORDER BY updated_at DESC`).all()
    ) as unknown as RecipeRow[]

    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      target: row.target as TargetKind,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      stepCount: this.countSteps(row.body),
    }))
  }

  getRecipe(id: string): { summary: RecipeSummary; body: Recipe } | undefined {
    const row = this.db.prepare(`SELECT * FROM recipes WHERE id = ?`).get(id) as unknown as RecipeRow | undefined
    if (!row) return undefined
    return { summary: this.toSummary(row), body: JSON.parse(row.body) as Recipe }
  }

  createRecipe(input: {
    projectId: string
    name: string
    target: TargetKind
    recipe: Recipe
  }): RecipeSummary {
    const now = Date.now()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO recipes (id, project_id, name, target, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.projectId, input.name, input.target, JSON.stringify(input.recipe), now, now)
    this.touchProject(input.projectId)
    return this.getRecipe(id)!.summary
  }

  updateRecipe(
    id: string,
    patch: { name?: string; target?: TargetKind; recipe?: Recipe },
  ): RecipeSummary | undefined {
    const existing = this.getRecipe(id)
    if (!existing) return undefined
    const name = patch.name ?? existing.summary.name
    const target = patch.target ?? existing.summary.target
    const body = patch.recipe ?? existing.body
    const changed = JSON.stringify(body) !== JSON.stringify(existing.body)

    if (changed) {
      this.saveRevision(id, existing.body, `antes de ${name}`)
    }

    this.db
      .prepare(`UPDATE recipes SET name = ?, target = ?, body = ?, updated_at = ? WHERE id = ?`)
      .run(name, target, JSON.stringify(body), Date.now(), id)
    this.touchProject(existing.summary.projectId)
    return this.getRecipe(id)!.summary
  }

  // ── revisões ────────────────────────────────────────────────────────────

  /** Guarda uma cópia do corpo anterior da receita. */
  saveRevision(recipeId: string, body: Recipe, label?: string): string {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO recipe_revisions (id, recipe_id, body, label, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, recipeId, JSON.stringify(body), label ?? null, Date.now())
    return id
  }

  listRevisions(recipeId: string): { id: string; label: string | null; createdAt: number }[] {
    const rows = this.db
      .prepare(
        `SELECT id, label, created_at FROM recipe_revisions WHERE recipe_id = ? ORDER BY created_at DESC`,
      )
      .all(recipeId) as unknown as { id: string; label: string | null; created_at: number }[]
    return rows.map((row) => ({ id: row.id, label: row.label, createdAt: row.created_at }))
  }

  getRevision(id: string): { id: string; recipeId: string; body: Recipe; label: string | null } | undefined {
    const row = this.db.prepare(`SELECT * FROM recipe_revisions WHERE id = ?`).get(id) as unknown as
      | { id: string; recipe_id: string; body: string; label: string | null }
      | undefined
    if (!row) return undefined
    return {
      id: row.id,
      recipeId: row.recipe_id,
      body: JSON.parse(row.body) as Recipe,
      label: row.label,
    }
  }

  /** Corpo de uma revisão, ou undefined se não existir. */
  getRevisionBody(id: string): Recipe | undefined {
    return this.getRevision(id)?.body
  }

  // ── agendamentos ────────────────────────────────────────────────────────

  createSchedule(input: {
    recipeId: string
    cron: string
    driver?: string
  }): { id: string; recipeId: string; cron: string; driver: string; enabled: boolean; createdAt: number } {
    const id = randomUUID()
    const createdAt = Date.now()
    this.db
      .prepare(
        `INSERT INTO schedules (id, recipe_id, cron, driver, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(id, input.recipeId, input.cron, input.driver ?? "playwright", createdAt)
    return {
      id,
      recipeId: input.recipeId,
      cron: input.cron,
      driver: input.driver ?? "playwright",
      enabled: true,
      createdAt,
    }
  }

  listSchedules(): {
    id: string
    recipeId: string
    cron: string
    driver: string
    enabled: boolean
    lastRunAt?: number
    createdAt: number
  }[] {
    const rows = this.db
      .prepare(`SELECT * FROM schedules ORDER BY created_at DESC`)
      .all() as unknown as {
      id: string
      recipe_id: string
      cron: string
      driver: string
      enabled: number
      last_run_at: number | null
      created_at: number
    }[]
    return rows.map((row) => ({
      id: row.id,
      recipeId: row.recipe_id,
      cron: row.cron,
      driver: row.driver,
      enabled: row.enabled === 1,
      lastRunAt: row.last_run_at ?? undefined,
      createdAt: row.created_at,
    }))
  }

  deleteSchedule(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id)
    return Number(result.changes) > 0
  }

  markScheduleRun(id: string): void {
    this.db.prepare(`UPDATE schedules SET last_run_at = ? WHERE id = ?`).run(Date.now(), id)
  }

  deleteRecipe(id: string): boolean {
    const existing = this.getRecipe(id)
    const result = this.db.prepare(`DELETE FROM recipes WHERE id = ?`).run(id)
    if (existing) this.touchProject(existing.summary.projectId)
    return Number(result.changes) > 0
  }

  // ── execuções ─────────────────────────────────────────────────────────────

  createRun(input: {
    recipeId?: string
    recipeName?: string
    driver: string
    status: RunSummary["status"]
  }): RunSummary {
    const id = randomUUID()
    const startedAt = Date.now()
    this.db
      .prepare(
        `INSERT INTO runs (id, recipe_id, recipe_name, driver, status, started_at, log)
         VALUES (?, ?, ?, ?, ?, ?, '[]')`,
      )
      .run(id, input.recipeId ?? null, input.recipeName ?? null, input.driver, input.status, startedAt)
    return {
      id,
      recipeId: input.recipeId ?? "",
      recipeName: input.recipeName,
      driver: input.driver,
      status: input.status,
      startedAt,
    }
  }

  updateRun(
    id: string,
    patch: {
      status?: RunSummary["status"]
      endedAt?: number
      error?: string
      scope?: Record<string, unknown>
      log?: unknown[]
    },
  ): RunSummary | undefined {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as unknown as RunRow | undefined
    if (!row) return undefined
    this.db
      .prepare(
        `UPDATE runs SET status = ?, ended_at = ?, error = ?, scope = ?, log = ? WHERE id = ?`,
      )
      .run(
        patch.status ?? row.status,
        patch.endedAt ?? row.ended_at ?? null,
        patch.error ?? row.error ?? null,
        patch.scope ? JSON.stringify(patch.scope) : (row.scope ?? null),
        patch.log ? JSON.stringify(patch.log) : row.log,
        id,
      )
    return this.getRun(id)
  }

  getRun(id: string): RunSummary | undefined {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as unknown as RunRow | undefined
    if (!row) return undefined
    return {
      id: row.id,
      recipeId: row.recipe_id ?? "",
      recipeName: row.recipe_name ?? undefined,
      driver: row.driver,
      status: row.status as RunSummary["status"],
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      error: row.error ?? undefined,
      scope: row.scope ? (JSON.parse(row.scope) as Record<string, unknown>) : undefined,
    }
  }

  listRuns(limit = 20): RunSummary[] {
    const rows = this.db
      .prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`)
      .all(limit) as unknown as RunRow[]
    return rows.map((row) => ({
      id: row.id,
      recipeId: row.recipe_id ?? "",
      recipeName: row.recipe_name ?? undefined,
      driver: row.driver,
      status: row.status as RunSummary["status"],
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      error: row.error ?? undefined,
    }))
  }

  /**
   * Encerra execuções que ficaram pendentes quando o servidor caiu.
   *
   * O estado de uma execução em andamento vive na memória do processo: o
   * temporizador que aborta a espera pela aba e o controlador que cancela.
   * Um reinício leva esse estado junto, e a execução não termina nunca — o
   * painel mostra um "em andamento" que não acaba e o cancelamento não
   * encontra nada para interromper. Aqui elas são fechadas com um motivo
   * explícito.
   */
  closeOrphanedRuns(reason: string): RunSummary[] {
    const rows = this.db
      .prepare(`SELECT id FROM runs WHERE status = 'running'`)
      .all() as unknown as { id: string }[]
    if (!rows.length) return []

    const agora = Date.now()
    const fechar = this.db.prepare(
      `UPDATE runs SET status = 'error', ended_at = ?, error = ? WHERE id = ?`,
    )
    for (const row of rows) fechar.run(agora, reason, row.id)

    return rows
      .map((row) => this.getRun(row.id))
      .filter((run): run is RunSummary => run !== undefined)
  }

  getRunLog(id: string): unknown[] {
    const row = this.db.prepare(`SELECT log FROM runs WHERE id = ?`).get(id) as unknown as
      | { log: string }
      | undefined
    if (!row) return []
    try {
      return JSON.parse(row.log) as unknown[]
    } catch {
      return []
    }
  }

  // ── conversas ─────────────────────────────────────────────────────────────

  createChatSession(input: { projectId?: string; opencodeSessionId?: string; title?: string }): {
    id: string
    projectId?: string
    opencodeSessionId?: string
    title: string
    createdAt: number
  } {
    const now = Date.now()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO chat_sessions (id, project_id, opencode_session_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.projectId ?? null, input.opencodeSessionId ?? null, input.title ?? "Nova conversa", now, now)
    return {
      id,
      projectId: input.projectId,
      opencodeSessionId: input.opencodeSessionId,
      title: input.title ?? "Nova conversa",
      createdAt: now,
    }
  }

  setChatOpencodeSession(id: string, opencodeSessionId: string, title?: string): void {
    this.db
      .prepare(
        `UPDATE chat_sessions SET opencode_session_id = ?, title = COALESCE(?, title), updated_at = ? WHERE id = ?`,
      )
      .run(opencodeSessionId, title ?? null, Date.now(), id)
  }

  listChatSessions(): { id: string; title: string; createdAt: number }[] {
    const rows = this.db
      .prepare(`SELECT id, title, created_at FROM chat_sessions ORDER BY updated_at DESC`)
      .all() as unknown as { id: string; title: string; created_at: number }[]
    return rows.map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at }))
  }

  getChatSession(id: string):
    | { id: string; projectId?: string; opencodeSessionId?: string; title: string; createdAt: number }
    | undefined {
    const row = this.db.prepare(`SELECT * FROM chat_sessions WHERE id = ?`).get(id) as unknown as
      | {
          id: string
          project_id: string | null
          opencode_session_id: string | null
          title: string
          created_at: number
        }
      | undefined
    if (!row) return undefined
    return {
      id: row.id,
      projectId: row.project_id ?? undefined,
      opencodeSessionId: row.opencode_session_id ?? undefined,
      title: row.title,
      createdAt: row.created_at,
    }
  }

  // ── auxiliares ────────────────────────────────────────────────────────────

  private touchProject(id: string): void {
    this.db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).run(Date.now(), id)
  }

  private toSummary(row: RecipeRow): RecipeSummary {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      target: row.target as TargetKind,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      stepCount: this.countSteps(row.body),
    }
  }

  private countSteps(body: string): number {
    try {
      const recipe = JSON.parse(body) as Recipe
      return recipe.steps?.length ?? 0
    } catch {
      return 0
    }
  }
}
