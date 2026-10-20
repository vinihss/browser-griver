import type { AddressInfo } from "node:net"
import type { ClientMessage, Recipe, TargetKind } from "@griver/core"
import { loadConfig, type ServerConfig } from "./config.js"
import { openDatabase } from "./db/index.js"
import { Repository } from "./db/repo.js"
import { Router, createHttpServer } from "./http/server.js"
import { registerApi } from "./http/api.js"
import { WsGateway, type ClientConnection } from "./ws/gateway.js"
import { RunManager } from "./runner/index.js"
import { TabRunCoordinator } from "./runner/tab.js"
import { RecordingBuffer } from "./recording/buffer.js"
import { OpenCodeClient } from "./opencode/client.js"
import { ChatBridge } from "./opencode/bridge.js"
import { Scheduler } from "./scheduler.js"
import { createPlaywrightDriver } from "./drivers/playwright.js"
import { createFirecrawlDriver } from "./drivers/firecrawl.js"

export const SERVER_VERSION = "0.1.0"

export interface GriverServer {
  config: ServerConfig
  url: string
  /** execuções que estavam pendentes quando o processo anterior caiu */
  orphanedRuns: number
  close(): Promise<void>
}

export async function startServer(overrides: Partial<ServerConfig> = {}): Promise<GriverServer> {
  const config = loadConfig(overrides)

  const db = openDatabase(config.dbPath)
  const repo = new Repository(db)
  const recording = new RecordingBuffer()

  // Execuções em andamento de um processo anterior não vão terminar: o
  // temporizador que as aguardava vivia na memória que o reinício levou
  // junto. Elas são fechadas aqui para não ficarem eternas no painel.
  const orphanedRuns = repo.closeOrphanedRuns("servidor reiniciou durante a execução").length

  // o gateway precisa do servidor HTTP, então criamos o HTTP primeiro
  const router = new Router()
  const server = createHttpServer(router, { token: config.token })

  // o despachante é atribuído depois que as dependências existem
  let dispatch: (client: ClientConnection, message: ClientMessage) => Promise<void> = async () => {}
  const wsGateway = new WsGateway(server, config.token, {
    serverVersion: SERVER_VERSION,
    onMessage: (client, message) => dispatch(client, message),
  })

  const runs = new RunManager({
    repo,
    onEvent: (runId, event) => {
      wsGateway.broadcast({ type: "run.event", runId, event })
    },
    onFinished: (runId) => {
      const run = repo.getRun(runId)
      if (run) wsGateway.broadcast({ type: "run.finished", run })
    },
  })

  const tabRuns = new TabRunCoordinator(wsGateway, repo)
  const scheduler = new Scheduler(repo, runs)

  const opencode = new OpenCodeClient(config.opencodeConfigDir)
  const chat = new ChatBridge(opencode, repo, {
    onMessage: (sessionId, message) => {
      wsGateway.broadcast({ type: "chat.message", sessionId, message })
    },
    onTool: (sessionId, toolName, state, input) => {
      wsGateway.broadcast({ type: "chat.tool", sessionId, toolName, state, input })
    },
    onPermission: (sessionId, request) => {
      wsGateway.broadcast({
        type: "chat.permission",
        requestId: request.id,
        action: request.action,
        resources: request.resources,
        title: request.message,
      })
    },
    onError: (sessionId, message) => {
      wsGateway.broadcast({
        type: "chat.message",
        sessionId,
        message: { id: `err_${Date.now()}`, role: "system", text: message, createdAt: Date.now() },
      })
    },
  })

  registerApi(router, {
    repo,
    runs,
    tabRuns,
    recording,
    chat,
    gateway: wsGateway,
    version: SERVER_VERSION,
    firecrawlConfigured: Boolean(config.firecrawlApiKey),
    token: config.token,
  })

  // ── mensagens da extensão ────────────────────────────────────────────────

  dispatch = async (client, message: ClientMessage) => {
    await handleExtensionMessage(client, message)
  }

  async function handleExtensionMessage(
    client: ClientConnection,
    message: ClientMessage,
  ): Promise<void> {
    switch (message.type) {
      case "project.list":
        wsGateway.broadcast({ type: "projects", projects: repo.listProjects() })
        break
      case "project.create": {
        const project = repo.createProject(message.name.trim(), message.description?.trim())
        wsGateway.broadcast({ type: "projects.changed" })
        wsGateway.broadcast({ type: "project", project })
        break
      }
      case "project.update": {
        const project = repo.updateProject(message.id, message.patch)
        if (project) {
          wsGateway.broadcast({ type: "projects.changed" })
          wsGateway.broadcast({ type: "project", project })
        }
        break
      }
      case "project.delete":
        repo.deleteProject(message.id)
        wsGateway.broadcast({ type: "projects.changed" })
        wsGateway.broadcast({ type: "recipes.changed" })
        break
      case "recipe.list":
        wsGateway.broadcast({ type: "recipes", recipes: repo.listRecipes(message.projectId) })
        break
      case "recipe.create": {
        const recipe = repo.createRecipe({
          projectId: message.projectId,
          name: message.name.trim(),
          target: message.target,
          recipe: message.recipe,
        })
        wsGateway.broadcast({ type: "recipes.changed" })
        wsGateway.broadcast({ type: "recipe", recipe })
        break
      }
      case "recipe.update": {
        const recipe = repo.updateRecipe(message.id, message.patch)
        if (recipe) wsGateway.broadcast({ type: "recipes.changed" })
        break
      }
      case "recipe.delete":
        repo.deleteRecipe(message.id)
        wsGateway.broadcast({ type: "recipes.changed" })
        break
      // ── gravação ──────────────────────────────────────────────────────────
      //
      // A gravação pertence à extensão que a começou: só a donatária manda
      // eventos e recebe o estado. Mandar para todas misturava os passos de
      // uma aba com os de outra.

      case "record.start": {
        const snapshot = recording.start(client.id, message.projectId)
        wsGateway.send(client, {
          type: "record.state",
          state: snapshot.status,
          steps: snapshot.events.length,
          projectId: snapshot.projectId,
        })
        break
      }
      case "record.pause": {
        if (!recording.belongsTo(client.id)) break
        const snapshot = recording.pause(client.id)
        wsGateway.send(client, {
          type: "record.state",
          state: snapshot.status,
          steps: snapshot.events.length,
          projectId: snapshot.projectId,
        })
        break
      }
      case "record.resume": {
        if (!recording.belongsTo(client.id)) break
        const snapshot = recording.resume(client.id)
        wsGateway.send(client, {
          type: "record.state",
          state: snapshot.status,
          steps: snapshot.events.length,
          projectId: snapshot.projectId,
        })
        break
      }
      case "record.discard": {
        if (!recording.belongsTo(client.id)) break
        const snapshot = recording.discard(client.id)
        wsGateway.send(client, {
          type: "record.state",
          state: snapshot.status,
          steps: 0,
          projectId: snapshot.projectId,
        })
        break
      }
      case "record.stop": {
        if (!recording.belongsTo(client.id)) break
        const { snapshot, recipe } = recording.stop(client.id)
        wsGateway.send(client, {
          type: "record.state",
          state: snapshot.status,
          steps: 0,
          projectId: snapshot.projectId,
        })
        // a receita precisa vir junto: o painel usa esses passos ao salvar
        wsGateway.send(client, {
          type: "record.finished",
          stepCount: recipe.steps.length,
          recipe,
        })
        break
      }
      case "record.event": {
        const snapshot = recording.push(message.event, client.id)
        if (!recording.belongsTo(client.id)) break
        wsGateway.send(client, { type: "record.step", event: message.event })
        wsGateway.send(client, {
          type: "record.state",
          state: snapshot.status,
          steps: snapshot.events.length,
          projectId: snapshot.projectId,
        })
        break
      }
      case "run.start": {
        await startRunFromExtension(client, message.recipeId, message.driver ?? "tab", message.vars)
        break
      }
      case "run.cancel": {
        runs.cancel(message.runId)
        break
      }
      case "run.result": {
        tabRuns.handleResult(message)
        break
      }
      case "chat.create": {
        const session = await chat.createSession({ projectId: message.projectId })
        wsGateway.broadcast({ type: "chat.sessions", sessions: chat.listSessions() })
        wsGateway.broadcast({
          type: "chat.message",
          sessionId: session.id,
          message: {
            id: `sys_${Date.now()}`,
            role: "system",
            text: `Conversa "${session.title}" pronta.`,
            createdAt: Date.now(),
          },
        })
        break
      }
      case "chat.send": {
        try {
          await chat.send(message.sessionId, message.text)
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error)
          wsGateway.broadcast({
            type: "chat.message",
            sessionId: message.sessionId,
            message: { id: `err_${Date.now()}`, role: "system", text, createdAt: Date.now() },
          })
        }
        break
      }
      case "chat.list":
        wsGateway.broadcast({ type: "chat.sessions", sessions: chat.listSessions() })
        break
      case "permission.reply": {
        try {
          await chat.replyPermission(
            message.sessionId ?? "",
            message.requestId,
            message.reply,
            message.feedback,
          )
        } catch (error) {
          console.error("[ws] falha ao responder permissão:", error)
        }
        break
      }
      case "ping":
        wsGateway.broadcast({ type: "pong" })
        break
    }
  }

  async function startRunFromExtension(
    client: ClientConnection,
    recipeId: string,
    driver: string,
    vars?: Record<string, unknown>,
  ): Promise<void> {
    const found = repo.getRecipe(recipeId)
    if (!found) return

    const run = repo.createRun({
      recipeId: found.summary.id,
      recipeName: found.summary.name,
      driver,
      status: "running",
    })
    if (driver === "tab") {
      // a execução vai para a extensão que pediu: é a aba dela que deve
      // rodar a receita, não a de qualquer outra extensão conectada
      const result = await tabRuns.requestRun(run, found.summary.id, found.body, vars, client)
      void result
      return
    }

    wsGateway.broadcast({ type: "run.started", run })

    await runs.start({
      recipe: found.body,
      recipeId: found.summary.id,
      recipeName: found.summary.name,
      driver,
      vars,
      createDriver: async () => createDriver(driver, found.summary.target),
    })
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `a porta ${config.port} já está em uso. Rode com --port <outra> ou encerre o outro processo.`,
          ),
        )
        return
      }
      reject(error)
    })
    server.listen(config.port, config.host, () => resolve())
  })
  const address = server.address() as AddressInfo
  const url = `http://${config.host}:${address.port}`

  scheduler.start()

  return {
    config,
    url,
    orphanedRuns,
    async close() {
      scheduler.stop()
      await wsGateway.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      db.close()
    },
  }
}

/** Cria o driver pedido para a execução. */
export async function createDriver(driver: string, target: TargetKind) {
  if (target === "os" || driver === "firecrawl") {
    return await createFirecrawlDriver({ apiKey: process.env.FIRECRAWL_API_KEY })
  }
  if (driver === "cdp") {
    return await createPlaywrightDriver({ cdpUrl: process.env.GRIVER_CDP_URL ?? "http://127.0.0.1:9222" })
  }
  return await createPlaywrightDriver({ headed: driver === "playwright-headed" })
}

export type { Recipe }
