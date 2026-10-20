import {
  compileToFirecrawl,
  compileToPlaywright,
  recipeJsonSchema,
  safeParseRecipe,
  validateForTarget,
  type Recipe,
  type TargetKind,
} from "@griver/core"
import type { Repository } from "../db/repo.js"
import type { RunManager } from "../runner/index.js"
import type { TabRunCoordinator } from "../runner/tab.js"
import type { RecordingBuffer, RecordingSnapshot } from "../recording/buffer.js"
import type { ChatBridge } from "../opencode/bridge.js"
import type { WsGateway } from "../ws/gateway.js"
import { HttpError, type Router } from "./server.js"

export interface ApiContext {
  repo: Repository
  runs: RunManager
  tabRuns: TabRunCoordinator
  recording: RecordingBuffer
  chat: ChatBridge
  gateway: WsGateway
  version: string
  firecrawlConfigured: boolean
  /** token entregue à extensão via /api/extension-token */
  token: string
}

export function registerApi(router: Router, ctx: ApiContext): Router {
  const { repo, runs, tabRuns, recording, chat, gateway } = ctx

  // ── saúde ────────────────────────────────────────────────────────────────

  router.get("/api/health", () => ({
    ok: true,
    version: ctx.version,
    extensions: gateway.connectionCount,
    firecrawl: ctx.firecrawlConfigured,
  }))

  router.get("/api/info", () => ({
    name: "griver",
    version: ctx.version,
    extensions: gateway.connectionCount,
  }))

  /**
   * O schema da receita, em JSON Schema.
   *
   * Ele sai do Zod, então nunca sai de sincronia com o que o servidor
   * aceita. Serve para o editor da extensão (autocomplete e validação) e
   * para qualquer editor externo que queira validar uma receita sem
   * conhecer o Griver.
   */
  router.get("/api/schema/recipe", () => recipeJsonSchema())

  /**
   * Token de acesso, para a própria extensão.
   *
   * O Chrome não envia `Origin` em requisições feitas por uma extensão, mas
   * sempre envia em requisições de páginas da web — então a ausência de
   * `Origin` é o que distingue as duas. E como o CORS só é liberado para
   * origens `chrome-extension://`, uma página da web não consegue ler a
   * resposta de qualquer jeito.
   */
  router.get("/api/extension-token", (request) => {
    const origin = request.req.headers.origin
    const vemDaExtensao =
      origin === undefined || origin === "" || origin.startsWith("chrome-extension://")
    if (!vemDaExtensao) {
      throw new HttpError(403, "o token só é entregue à extensão do Griver")
    }
    return { token: ctx.token }
  })

  // ── projetos ────────────────────────────────────────────────────────────

  router.get("/api/projects", () => ({ projects: repo.listProjects() }))

  router.post("/api/projects", async (request) => {
    const body = (await request.body()) as { name?: string; description?: string } | undefined
    if (!body?.name?.trim()) throw new HttpError(400, "nome do projeto é obrigatório")
    const project = repo.createProject(body.name.trim(), body.description?.trim())
    gateway.broadcast({ type: "projects.changed" })
    return { project }
  })

  router.patch("/api/projects/:id", async (request) => {
    const body = (await request.body()) as { name?: string; description?: string } | undefined
    const project = repo.updateProject(request.params.id!, body ?? {})
    if (!project) throw new HttpError(404, "projeto não encontrado")
    gateway.broadcast({ type: "projects.changed" })
    return { project }
  })

  router.delete("/api/projects/:id", (request) => {
    const ok = repo.deleteProject(request.params.id!)
    if (!ok) throw new HttpError(404, "projeto não encontrado")
    gateway.broadcast({ type: "projects.changed" })
    gateway.broadcast({ type: "recipes.changed" })
    return { ok: true }
  })

  // ── receitas ────────────────────────────────────────────────────────────

  router.get("/api/recipes", (request) => ({
    recipes: repo.listRecipes(request.query.get("projectId") ?? undefined),
  }))

  router.get("/api/recipes/:id", (request) => {
    const found = repo.getRecipe(request.params.id!)
    if (!found) throw new HttpError(404, "receita não encontrada")
    return found
  })

  router.post("/api/recipes", async (request) => {
    const body = (await request.body()) as
      | { projectId?: string; name?: string; target?: TargetKind; recipe?: unknown }
      | undefined
    if (!body?.projectId) throw new HttpError(400, "projectId é obrigatório")
    if (!body.name?.trim()) throw new HttpError(400, "nome da receita é obrigatório")
    const target = body.target ?? "browser"
    if (target !== "browser" && target !== "os") throw new HttpError(400, "alvo inválido")

    const parsed = safeParseRecipe(body.recipe)
    if (!parsed.success) {
      throw new HttpError(400, "receita inválida", parsed.error.issues)
    }

    const issues = validateForTarget(parsed.data, target)
    const errors = issues.filter((issue) => issue.severity === "error")
    if (errors.length) {
      throw new HttpError(422, "receita contém passos incompatíveis com o alvo", errors)
    }

    const recipe = repo.createRecipe({
      projectId: body.projectId,
      name: body.name.trim(),
      target,
      recipe: parsed.data,
    })
    gateway.broadcast({ type: "recipes.changed" })
    return { recipe }
  })

  router.patch("/api/recipes/:id", async (request) => {
    const body = (await request.body()) as
      | { name?: string; target?: TargetKind; recipe?: unknown }
      | undefined
    const patch: { name?: string; target?: TargetKind; recipe?: Recipe } = {}
    if (body?.name !== undefined) patch.name = body.name
    if (body?.target !== undefined) patch.target = body.target
    if (body?.recipe !== undefined) {
      const parsed = safeParseRecipe(body.recipe)
      if (!parsed.success) throw new HttpError(400, "receita inválida", parsed.error.issues)
      patch.recipe = parsed.data
    }
    const recipe = repo.updateRecipe(request.params.id!, patch)
    if (!recipe) throw new HttpError(404, "receita não encontrada")
    gateway.broadcast({ type: "recipes.changed" })
    return { recipe }
  })

  router.delete("/api/recipes/:id", (request) => {
    const ok = repo.deleteRecipe(request.params.id!)
    if (!ok) throw new HttpError(404, "receita não encontrada")
    gateway.broadcast({ type: "recipes.changed" })
    return { ok: true }
  })

  router.post("/api/recipes/:id/compile", async (request) => {
    const body = (await request.body()) as { target?: TargetKind; headed?: boolean } | undefined
    const found = repo.getRecipe(request.params.id!)
    if (!found) throw new HttpError(404, "receita não encontrada")
    const target = body?.target ?? found.summary.target
    if (target === "os") {
      return { language: "typescript", target, code: compileToFirecrawl(found.body) }
    }
    return {
      language: "typescript",
      target,
      code: compileToPlaywright(found.body, { headed: body?.headed ?? false }),
    }
  })

  router.post("/api/validate", async (request) => {
    const body = (await request.body()) as { recipe?: unknown; target?: TargetKind } | undefined
    const parsed = safeParseRecipe(body?.recipe)
    if (!parsed.success) throw new HttpError(400, "receita inválida", parsed.error.issues)
    const target = body?.target ?? "browser"
    return { issues: validateForTarget(parsed.data, target) }
  })

  // ── revisões ────────────────────────────────────────────────────────────

  router.get("/api/recipes/:id/revisions", (request) => ({
    revisions: repo.listRevisions(request.params.id!),
  }))

  router.get("/api/recipes/:id/revisions/:revisionId", (request) => {
    const revision = repo.getRevision(request.params.revisionId!)
    if (!revision) throw new HttpError(404, "revisão não encontrada")
    return { revision }
  })

  router.post("/api/recipes/:id/revisions/:revisionId/restore", (request) => {
    const revision = repo.getRevision(request.params.revisionId!)
    if (!revision) throw new HttpError(404, "revisão não encontrada")
    const recipe = repo.updateRecipe(request.params.id!, { recipe: revision.body })
    if (!recipe) throw new HttpError(404, "receita não encontrada")
    gateway.broadcast({ type: "recipes.changed" })
    return { recipe }
  })

  // ── agendamentos ────────────────────────────────────────────────────────

  router.get("/api/schedules", () => ({ schedules: repo.listSchedules() }))

  router.post("/api/schedules", async (request) => {
    const body = (await request.body()) as
      | { recipeId?: string; cron?: string; driver?: string }
      | undefined
    if (!body?.recipeId) throw new HttpError(400, "recipeId é obrigatório")
    if (!body.cron?.trim()) throw new HttpError(400, "cron é obrigatório")
    if (!repo.getRecipe(body.recipeId)) throw new HttpError(404, "receita não encontrada")
    const schedule = repo.createSchedule({
      recipeId: body.recipeId,
      cron: body.cron.trim(),
      driver: body.driver,
    })
    return { schedule }
  })

  router.delete("/api/schedules/:id", (request) => {
    const ok = repo.deleteSchedule(request.params.id!)
    if (!ok) throw new HttpError(404, "agendamento não encontrado")
    return { ok: true }
  })

  // ── execuções ───────────────────────────────────────────────────────────

  router.get("/api/runs", () => ({ runs: repo.listRuns(50) }))

  router.get("/api/runs/:id", (request) => {
    const run = repo.getRun(request.params.id!)
    if (!run) throw new HttpError(404, "execução não encontrada")
    return { run, log: repo.getRunLog(request.params.id!) }
  })

  router.post("/api/runs", async (request) => {
    const body = (await request.body()) as
      | { recipeId?: string; driver?: string; vars?: Record<string, unknown> }
      | undefined
    if (!body?.recipeId) throw new HttpError(400, "recipeId é obrigatório")

    const found = repo.getRecipe(body.recipeId)
    if (!found) throw new HttpError(404, "receita não encontrada")

    const driver = body.driver ?? (found.summary.target === "os" ? "firecrawl" : "playwright")

    // `driver: "tab"` roda na aba ativa do navegador: a extensão executa a
    // receita e reporta o resultado de volta pelo WebSocket.
    if (driver === "tab") {
      const run = repo.createRun({
        recipeId: found.summary.id,
        recipeName: found.summary.name,
        driver,
        status: "running",
      })
      // o começo e o fim da execução vão só para a extensão que a executa
      void tabRuns.requestRun(run, found.summary.id, found.body, body.vars)
      return { runId: run.id }
    }

    const handle = await runs.start({
      recipe: found.body,
      recipeId: found.summary.id,
      recipeName: found.summary.name,
      driver,
      vars: body.vars,
      createDriver: async () => createDriverFor(driver, found.summary.target),
    })

    gateway.broadcast({ type: "run.started", run: repo.getRun(handle.id)! })
    return { runId: handle.id }
  })

  router.post("/api/runs/:id/cancel", (request) => {
    const ok = runs.cancel(request.params.id!)
    return { ok }
  })

  // ── gravação ────────────────────────────────────────────────────────────
  //
  // Quem captura os eventos é a extensão: ela é que injeta o gravador na
  // aba e manda cada evento. A API comanda — a extensão obedece — e o
  // estado volta pelo WebSocket, como no fluxo do painel.

  router.get("/api/recording", () => recording.snapshot())

  router.post("/api/recording/start", async (request) => {
    const body = (await request.body()) as { projectId?: string } | undefined
    return await comandarGravacao(gateway, recording, "start", body?.projectId)
  })

  router.post("/api/recording/pause", async () => {
    return await comandarGravacao(gateway, recording, "pause")
  })

  router.post("/api/recording/resume", async () => {
    return await comandarGravacao(gateway, recording, "resume")
  })

  router.post("/api/recording/discard", async () => {
    return await comandarGravacao(gateway, recording, "discard")
  })

  router.post("/api/recording/stop", async () => {
    return await comandarGravacao(gateway, recording, "stop")
  })

  // ── chat ────────────────────────────────────────────────────────────────

  router.get("/api/chat/sessions", () => ({ sessions: chat.listSessions() }))

  router.post("/api/chat/sessions", async (request) => {
    const body = (await request.body()) as { projectId?: string; title?: string } | undefined
    const session = await chat.createSession(body ?? {})
    return { session }
  })

  router.get("/api/chat/sessions/:id/messages", async (request) => {
    const local = repo.getChatSession(request.params.id!)
    if (!local) throw new HttpError(404, "conversa não encontrada")
    return { messages: local.opencodeSessionId ? await listMessages(local.opencodeSessionId) : [] }
  })

  router.get("/api/chat/sessions/:id", (request) => {
    const local = repo.getChatSession(request.params.id!)
    if (!local) throw new HttpError(404, "conversa não encontrada")
    return {
      session: local,
      executing: chat.isExecuting(request.params.id!),
    }
  })

  router.post("/api/chat/sessions/:id/prompt", async (request) => {
    const body = (await request.body()) as { text?: string } | undefined
    if (!body?.text?.trim()) throw new HttpError(400, "mensagem vazia")
    await chat.send(request.params.id!, body.text.trim())
    return { ok: true }
  })

  router.post("/api/chat/sessions/:id/interrupt", async (request) => {
    await chat.interrupt(request.params.id!)
    return { ok: true }
  })

  router.post("/api/chat/sessions/:id/permission", async (request) => {
    const body = (await request.body()) as
      | { requestId?: string; decision?: "once" | "always" | "reject"; feedback?: string }
      | undefined
    if (!body?.requestId || !body.decision) throw new HttpError(400, "requestId e decision são obrigatórios")
    await chat.replyPermission(request.params.id!, body.requestId, body.decision, body.feedback)
    return { ok: true }
  })

  // ── página (operado pela extensão) ──────────────────────────────────────

  router.post("/api/page/context", async () => {
    const result = await gateway.request({ action: "context" })
    if (!result.ok) throw new HttpError(502, result.error ?? "não foi possível inspecionar a aba")
    return result.result
  })

  router.post("/api/page/click", async (request) => {
    const body = (await request.body()) as { target?: { selectors?: string[]; text?: string } }
    if (!body?.target?.selectors?.length) throw new HttpError(400, "target.selectors é obrigatório")
    const result = await gateway.request({
      action: "click",
      payload: { target: body.target },
    })
    if (!result.ok) throw new HttpError(502, result.error ?? "falha ao clicar")
    return result.result ?? { ok: true }
  })

  router.post("/api/page/fill", async (request) => {
    const body = (await request.body()) as
      | { target?: { selectors?: string[] }; value?: string }
      | undefined
    if (!body?.target?.selectors?.length) throw new HttpError(400, "target.selectors é obrigatório")
    const result = await gateway.request({
      action: "fill",
      payload: { target: body.target, value: body.value ?? "" },
    })
    if (!result.ok) throw new HttpError(502, result.error ?? "falha ao preencher")
    return result.result ?? { ok: true }
  })

  router.post("/api/page/screenshot", async () => {
    const result = await gateway.request({ action: "screenshot" })
    if (!result.ok) throw new HttpError(502, result.error ?? "falha ao capturar a tela")
    return result.result
  })

  return router
}

/** Cria o driver adequado para a execução. */
async function createDriverFor(driver: string, target: TargetKind) {
  const { createPlaywrightDriver } = await import("../drivers/playwright.js")
  const { createFirecrawlDriver } = await import("../drivers/firecrawl.js")

  if (target === "os" || driver === "firecrawl") {
    return await createFirecrawlDriver({ apiKey: process.env.FIRECRAWL_API_KEY })
  }
  if (driver === "cdp") {
    const url = process.env.GRIVER_CDP_URL ?? "http://127.0.0.1:9222"
    return await createPlaywrightDriver({ cdpUrl: url })
  }
  return await createPlaywrightDriver({ headed: driver === "playwright-headed" })
}

/** Lista as mensagens de uma sessão do OpenCode. */
async function listMessages(opencodeSessionId: string): Promise<unknown[]> {
  const { OpenCodeClient } = await import("../opencode/client.js")
  const client = new OpenCodeClient(process.env.GRIVER_OPENCODE_CONFIG ?? `${process.env.HOME}/.config/opencode`)
  try {
    return await client.messages(opencodeSessionId)
  } catch {
    return []
  }
}

/**
 * Comanda a gravação e devolve o estado.
 *
 * Quem captura os eventos é a extensão: ela injeta o gravador na aba e
 * manda cada evento. A API comanda — a extensão obedece — e o estado
 * volta pelo WebSocket, como no fluxo do painel.
 *
 * Sem extensão conectada, o comando não tem quem o cumpra: a resposta diz
 * isso (`commanded: false`) e o estado continua como estava.
 */
async function comandarGravacao(
  gateway: WsGateway,
  recording: RecordingBuffer,
  action: "start" | "pause" | "resume" | "stop" | "discard",
  projectId?: string,
): Promise<{ snapshot: RecordingSnapshot; commanded: boolean; recipe?: Recipe }> {
  const commanded = gateway.connectionCount > 0
  if (commanded) {
    gateway.broadcast({ type: "record.command", action, ...(projectId ? { projectId } : {}) })
  }

  switch (action) {
    case "start": {
      // a sessão é aberta aqui: quem manda eventos é a extensão, mas a
      // gravação precisa de um lar antes do primeiro evento
      recording.start(undefined, projectId)
      // a extensão assume essa gravação quando ela confirmar pelo WebSocket
      await esperar(async () => recording.snapshot().status === "recording", 2_000)
      return { snapshot: recording.snapshot(), commanded }
    }
    case "pause": {
      await esperar(async () => recording.snapshot().status === "paused", 1_000)
      if (recording.snapshot().status === "recording") recording.pause()
      return { snapshot: recording.snapshot(), commanded }
    }
    case "resume": {
      await esperar(async () => recording.snapshot().status === "recording", 1_000)
      if (recording.snapshot().status === "paused") recording.resume()
      return { snapshot: recording.snapshot(), commanded }
    }
    case "discard": {
      await esperar(async () => recording.snapshot().status === "idle", 1_000)
      recording.discard()
      return { snapshot: recording.snapshot(), commanded }
    }
    case "stop": {
      // a extensão fecha a gravação e entrega a receita; a API espera
      const terminou = await recording.waitFinished(3_000)
      if (terminou) {
        return { snapshot: recording.snapshot(), commanded, recipe: terminou.recipe }
      }
      // nenhuma extensão respondeu: encerra aqui mesmo
      const { snapshot, recipe } = recording.stop()
      return { snapshot, commanded, recipe }
    }
  }
}

/** Espera uma condição valer, até o prazo. */
async function esperar(condicao: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const limite = Date.now() + timeoutMs
  while (Date.now() < limite) {
    if (await condicao()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
