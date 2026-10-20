import { runRecipe, type Recipe, type StepEvent } from "@griver/core/runtime"
import type { RecordedEvent } from "@griver/core/protocol"
import { INTERNAL, STORAGE } from "../shared/constants.js"
import { WsClient, type ConnectionStatus } from "./ws-client.js"
import { TabDriver, injectRecorder } from "./tab-driver.js"

type PanelMessage = { type: string; [key: string]: unknown }

// ── estado do service worker ────────────────────────────────────────────────

const state = {
  status: "offline" as ConnectionStatus,
  recording: false,
  recordingPaused: false,
  recordingSteps: 0,
  recordingTabId: undefined as number | undefined,
  activeTabId: undefined as number | undefined,
  lastServerMessages: [] as unknown[],
}

const ws = new WsClient({
  getUrl: async () => {
    const stored = await chrome.storage.local.get([STORAGE.serverUrl, STORAGE.token])
    return {
      url: (stored[STORAGE.serverUrl] as string) || "http://127.0.0.1:7331",
      token: (stored[STORAGE.token] as string) || "",
    }
  },
  onMessage: (message) => {
    void handleServerMessage(message)
  },
  onStatus: (status) => {
    state.status = status
    broadcast({ type: "connection", status })
  },
})

// ── ciclo de vida ───────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined)
  void connect()
})

chrome.runtime.onStartup.addListener(() => {
  void connect()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "griver:keepalive") void connect()
})

async function connect(): Promise<void> {
  // O alarm é só um keepalive para reidratar o service worker. O Chrome 120+
  // exige período mínimo de 30 segundos (0.5 min) e rejeita valores menores
  // — então a criação não pode bloquear a conexão do WebSocket.
  void chrome.alarms
    .create("griver:keepalive", { periodInMinutes: 0.5 })
    .catch(() => undefined)
  await ensureToken()
  await ws.connect()
}

/**
 * Garante que o token salvo é o do servidor atual.
 *
 * O servidor entrega o token apenas à própria extensão, então não existe mais
 * o risco de o token guardado estar desatualizado depois de um reinício.
 */
async function ensureToken(): Promise<void> {
  const stored = await chrome.storage.local.get([STORAGE.serverUrl, STORAGE.token])
  const url = (stored[STORAGE.serverUrl] as string) || "http://127.0.0.1:7331"

  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/api/extension-token`)
    if (!response.ok) return
    const body = (await response.json()) as { token?: string }
    if (!body.token) return
    if (body.token !== stored[STORAGE.token]) {
      await chrome.storage.local.set({ [STORAGE.token]: body.token })
    }
  } catch {
    // servidor fora do ar — segue com o token guardado
  }
}

// ── mensagens do painel ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: PanelMessage, sender, sendResponse) => {
  switch (message.type) {
    case "panel:connect":
      void (async () => {
        await chrome.storage.local.set({
          [STORAGE.serverUrl]: message.url,
          [STORAGE.token]: message.token,
        })
        await ensureToken()
        await connect()
        sendResponse({ ok: true, status: state.status })
      })()
      return true

    case "panel:disconnect":
      ws.close()
      sendResponse({ ok: true })
      return false

    case "panel:status":
      void (async () => {
        await ensureToken()
        const stored = await chrome.storage.local.get([STORAGE.token])
        sendResponse({
          ok: true,
          status: state.status,
          token: (stored[STORAGE.token] as string) || "",
          recording: state.recording,
          recordingPaused: state.recordingPaused,
          recordingSteps: state.recordingSteps,
        })
      })()
      return true

    case "panel:record": {
      void handleRecordCommand(String(message.action)).catch((error) => {
        // sem isso a gravação falharia em silêncio e o painel não saberia
        const texto = error instanceof Error ? error.message : String(error)
        console.error("[griver] falha no comando de gravação:", error)
        broadcast({
          type: "server",
          message: { type: "error", message: `Gravação: ${texto}` },
        })
      })
      sendResponse({ ok: true })
      return false
    }

    case "panel:run": {
      void handleRunRequest(
        message.recipe as Recipe,
        message.driver as string | undefined,
        message.vars as Record<string, unknown> | undefined,
      )
      sendResponse({ ok: true })
      return false
    }

    case "panel:send": {
      ws.send(message.payload as never)
      sendResponse({ ok: true })
      return false
    }

    case "panel:tab": {
      void (async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        sendResponse({ ok: true, tabId: tab?.id, url: tab?.url, title: tab?.title })
      })()
      return true
    }

    default:
      return false
  }
})

// ── gravação ────────────────────────────────────────────────────────────────

async function handleRecordCommand(action: string): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return

  if (!/^(https?|file):/i.test(tab.url ?? "")) {
    throw new Error(
      "esta página não pode ser gravada. Abra uma página comum (http/https) e tente de novo.",
    )
  }

  state.activeTabId = tab.id

  switch (action) {
    case "start":
      await injectRecorder(tab.id)
      await chrome.tabs.sendMessage(tab.id, {
        type: INTERNAL.recordCommand,
        command: { action: "start" },
      })
      state.recording = true
      state.recordingPaused = false
      state.recordingSteps = 0
      state.recordingTabId = tab.id
      // o servidor precisa saber que a gravação começou antes de receber eventos
      ws.send({ type: "record.start", projectId: currentProjectId, tabId: tab.id })
      watchNavigation(tab.id)
      // a URL inicial é o primeiro passo da receita
      if (tab.url) {
        emitRecordEvent({ kind: "navigate", url: tab.url, ts: Date.now() })
      }
      broadcast({ type: "recording", recording: true, paused: false, steps: 0 })
      break

    case "pause":
      await chrome.tabs.sendMessage(tab.id, {
        type: INTERNAL.recordCommand,
        command: { action: "pause" },
      })
      state.recordingPaused = true
      ws.send({ type: "record.pause" })
      broadcast({ type: "recording", recording: true, paused: true, steps: state.recordingSteps })
      break

    case "resume":
      await chrome.tabs.sendMessage(tab.id, {
        type: INTERNAL.recordCommand,
        command: { action: "resume" },
      })
      state.recordingPaused = false
      ws.send({ type: "record.resume" })
      broadcast({ type: "recording", recording: true, paused: false, steps: state.recordingSteps })
      break

    case "stop": {
      const resposta = (await chrome.tabs.sendMessage(tab.id, {
        type: INTERNAL.recordCommand,
        command: { action: "stop" },
      })) as { ok: boolean; events?: RecordedEvent[] } | undefined

      state.recording = false
      state.recordingPaused = false
      chrome.webNavigation.onCommitted.removeListener(onNavigation)

      // o que sobrou no content script entra antes do encerramento
      for (const evento of resposta?.events ?? []) emitRecordEvent(evento)
      // pequena margem para eventos que ainda estavam a caminho
      await new Promise((resolve) => setTimeout(resolve, 120))

      ws.send({ type: "record.stop" })
      broadcast({ type: "recording", recording: false, paused: false, steps: state.recordingSteps })
      break
    }

    case "discard":
      await chrome.tabs.sendMessage(tab.id, {
        type: INTERNAL.recordCommand,
        command: { action: "stop" },
      })
      state.recording = false
      state.recordingPaused = false
      state.recordingSteps = 0
      chrome.webNavigation.onCommitted.removeListener(onNavigation)
      ws.send({ type: "record.discard" })
      broadcast({ type: "recording", recording: false, paused: false, steps: 0 })
      break
  }
}

let currentProjectId = ""

chrome.runtime.onMessage.addListener((message: PanelMessage) => {
  if (message.type === "panel:project") {
    currentProjectId = String(message.projectId ?? "")
  }
})

// eventos capturados pelo content script
chrome.runtime.onMessage.addListener((message: PanelMessage) => {
  if (message.type !== INTERNAL.recordEvent) return
  emitRecordEvent(message.event as never)
})

/** Registra um evento de gravação e encaminha ao servidor. */
function emitRecordEvent(event: RecordedEvent): void {
  state.recordingSteps += 1
  ws.send({ type: "record.event", event })
  broadcast({
    type: "recording",
    recording: state.recording,
    paused: state.recordingPaused,
    steps: state.recordingSteps,
  })
}

/** Acompanha navigações da aba gravada para virar um passo `navigate`. */
function watchNavigation(tabId: number): void {
  state.recordingTabId = tabId
  chrome.webNavigation.onCommitted.removeListener(onNavigation)
  chrome.webNavigation.onCommitted.addListener(onNavigation)
}

function onNavigation(details: chrome.webNavigation.NavigationEvent): void {
  if (details.tabId !== state.recordingTabId || details.frameId !== 0) return
  if (!state.recording) return
  emitRecordEvent({ kind: "navigate", url: details.url, ts: Date.now() })
}

// ── execução na aba ─────────────────────────────────────────────────────────

async function handleRunRequest(
  recipe: Recipe,
  driver: string | undefined,
  vars: Record<string, unknown> | undefined,
): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return

  const events: StepEvent[] = []
  const tabDriver = new TabDriver(tab.id)

  const result = await runRecipe(recipe, tabDriver, {
    scope: vars,
    onStep: (event) => {
      events.push(event)
      broadcast({ type: "run-step", event })
    },
  })

  ws.send({
    type: "run.result",
    runId: currentRunId,
    status: result.status,
    events,
    error: result.error?.message,
    scope: result.scope,
  })
}

let currentRunId = ""

chrome.runtime.onMessage.addListener((message: PanelMessage) => {
  if (message.type === "panel:runId") {
    currentRunId = String(message.runId ?? "")
  }
})

// ── mensagens do servidor ───────────────────────────────────────────────────

async function handleServerMessage(message: { type: string; [key: string]: unknown }): Promise<void> {
  broadcast({ type: "server", message })

  switch (message.type) {
    case "error": {
      // token desatualizado: busca o atual e reconecta
      if (typeof message.message === "string" && message.message.includes("token inválido")) {
        await ensureToken()
        ws.close()
        await connect()
      }
      return
    }

    case "run.request": {
      currentRunId = String(message.runId)
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) {
        ws.send({
          type: "run.result",
          runId: currentRunId,
          status: "error",
          events: [],
          error: "nenhuma aba ativa",
        })
        return
      }
      const events: StepEvent[] = []
      const tabDriver = new TabDriver(tab.id)
      const result = await runRecipe(message.recipe as Recipe, tabDriver, {
        scope: message.vars as Record<string, unknown> | undefined,
        onStep: (event) => {
          events.push(event)
          broadcast({ type: "run-step", event })
        },
      })
      ws.send({
        type: "run.result",
        runId: currentRunId,
        status: result.status,
        events,
        error: result.error?.message,
        scope: result.scope,
      })
      return
    }

    case "page.request": {
      const response = await runPageCommand(message.request as PageCommandLike)
      ws.send({ type: "page.result", id: String(message.id), result: response })
      return
    }

    case "record.state": {
      state.recording = message.state === "recording" || message.state === "paused"
      state.recordingPaused = message.state === "paused"
      state.recordingSteps = Number(message.steps ?? 0)
      broadcast({
        type: "recording",
        recording: state.recording,
        paused: state.recordingPaused,
        steps: state.recordingSteps,
      })
      return
    }
  }
}

interface PageCommandLike {
  action: "context" | "click" | "fill" | "evaluate" | "screenshot"
  payload?: Record<string, unknown>
}

/** Executa um comando na aba ativa e devolve o resultado. */
async function runPageCommand(request: PageCommandLike): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) return { ok: false, error: "nenhuma aba ativa" }

    if (request.action === "screenshot") {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.id)
      return { ok: true, result: { base64: dataUrl.split(",")[1], mimeType: "image/png" } }
    }

    await injectRecorder(tab.id)
    const response = (await chrome.tabs.sendMessage(tab.id, {
      type: INTERNAL.pageCommand,
      command: request,
    })) as { ok: boolean; result?: unknown; error?: string } | undefined

    if (!response) return { ok: false, error: "sem resposta do content script" }
    return response.ok ? { ok: true, result: response.result } : { ok: false, error: response.error }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ──painel ──────────────────────────────────────────────────────────────────

function broadcast(message: PanelMessage): void {
  void chrome.runtime.sendMessage(message).catch(() => undefined)
}

// reidrata o estado quando o service worker é reativado
void connect()
