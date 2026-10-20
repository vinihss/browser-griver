import { runRecipe, type Recipe, type StepEvent } from "@griver/core/runtime"
import type { RecordedEvent } from "@griver/core/protocol"
import { INTERNAL, STORAGE, type OverlayAction } from "../shared/constants.js"
import { WsClient, type ConnectionStatus } from "./ws-client.js"
import { TabDriver, injectRecorder } from "./tab-driver.js"

type PanelMessage = { type: string; [key: string]: unknown }

/** Estado que o overlay desenha. */
interface OverlayState {
  visible: boolean
  recording: boolean
  paused: boolean
  steps: number
  events: RecordedEvent[]
  recipe?: Recipe
  confirmed: boolean
}

// ── estado do service worker ────────────────────────────────────────────────

const state = {
  status: "offline" as ConnectionStatus,
  recording: false,
  recordingPaused: false,
  recordingSteps: 0,
  recordingTabId: undefined as number | undefined,
  activeTabId: undefined as number | undefined,
  lastServerMessages: [] as unknown[],
  /** eventos capturados durante a gravação (a fonte é o servidor) */
  recordingEvents: [] as RecordedEvent[],
  /** receita pronta, enviada pelo servidor ao parar a gravação */
  recordedRecipe: undefined as Recipe | undefined,
  /** o usuário confirmou a gravação no overlay */
  recordingConfirmed: false,
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
        const url = String(message.url ?? "")
        const token = String(message.token ?? "")
        // o painel pode não ter token nenhum (ele é lido do servidor): não
        // sobrescreve o token guardado com string vazia, senão a reconexão
        // manda `hello` sem token e o servidor responde "token inválido"
        const update: Record<string, string> = { [STORAGE.serverUrl]: url }
        if (token) update[STORAGE.token] = token
        await chrome.storage.local.set(update)
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
      void handleOverlayAction(String(message.action) as OverlayAction).catch((error) => {
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

    case INTERNAL.overlayQuery: {
      // o content script pergunta o que exibir — é assim que o overlay
      // reaparece depois de uma navegação
      sendResponse(overlayState())
      return false
    }

    case INTERNAL.overlayCommand: {
      void handleOverlayAction(String(message.action) as OverlayAction).catch((error) => {
        const texto = error instanceof Error ? error.message : String(error)
        console.error("[griver] falha no comando do overlay:", error)
        broadcast({
          type: "server",
          message: { type: "error", message: `Gravação: ${texto}` },
        })
      })
      sendResponse({ ok: true })
      return false
    }

    default:
      return false
  }
})

// ── gravação: o service worker é o dono do estado ───────────────────────────
//
// O content script morre a cada navegação, mas a gravação precisa sobreviver
// a ela — o primeiro passo de uma receita costuma ser justamente navegar.
// Por isso o estado fica aqui, e o content script só captura eventos.

async function handleOverlayAction(action: OverlayAction): Promise<void> {
  switch (action) {
    case "start":
      await startRecording()
      return
    case "pause":
      await pauseRecording()
      return
    case "resume":
      await resumeRecording()
      return
    case "stop":
      await stopRecording()
      return
    case "cancel":
      await cancelRecording()
      return
    case "confirm":
      state.recordingConfirmed = true
      await pushOverlayState()
      return
    case "edit":
      await openDraftInPanel()
      return
    case "save":
      await openDraftInPanel(true)
      return
  }
}

/** Começa a gravação na aba ativa. */
async function startRecording(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error("nenhuma aba ativa")

  if (!/^(https?|file):/i.test(tab.url ?? "")) {
    throw new Error(
      "esta página não pode ser gravada. Abra uma página comum (http/https) e tente de novo.",
    )
  }

  state.activeTabId = tab.id
  state.recording = true
  state.recordingPaused = false
  state.recordingSteps = 0
  state.recordingEvents = []
  state.recordedRecipe = undefined
  state.recordingConfirmed = false
  state.recordingTabId = tab.id

  await injectRecorder(tab.id)
  await sendRecordCommand(tab.id, "start")

  // o servidor precisa saber que a gravação começou antes de receber eventos
  ws.send({ type: "record.start", projectId: currentProjectId, tabId: tab.id })
  watchNavigation(tab.id)

  // a URL inicial é o primeiro passo da receita
  if (tab.url) {
    emitRecordEvent({ kind: "navigate", url: tab.url, ts: Date.now() })
  }

  await pushOverlayState()
}

/** Pausa a captura: os eventos deixam de ser gravados, mas o overlay fica. */
async function pauseRecording(): Promise<void> {
  if (!state.recording || state.recordingPaused) return
  const tabId = state.recordingTabId
  if (tabId !== undefined) await sendRecordCommand(tabId, "pause")
  state.recordingPaused = true
  ws.send({ type: "record.pause" })
  await pushOverlayState()
}

/** Retoma a captura. */
async function resumeRecording(): Promise<void> {
  if (!state.recording || !state.recordingPaused) return
  const tabId = state.recordingTabId
  if (tabId !== undefined) await sendRecordCommand(tabId, "resume")
  state.recordingPaused = false
  ws.send({ type: "record.resume" })
  await pushOverlayState()
}

/**
 * Para a gravação.
 *
 * O overlay continua visível com os passos capturados: o usuário ainda pode
 * editar ou salvar a receita.
 */
async function stopRecording(): Promise<void> {
  if (!state.recording) return
  const tabId = state.recordingTabId

  if (tabId !== undefined) {
    const resposta = (await chrome.tabs.sendMessage(tabId, {
      type: INTERNAL.recordCommand,
      command: { action: "stop" },
    })) as { ok: boolean; events?: RecordedEvent[] } | undefined

    // o que sobrou no content script entra antes do encerramento
    for (const evento of resposta?.events ?? []) emitRecordEvent(evento)
    // pequena margem para eventos que ainda estavam a caminho
    await new Promise((resolve) => setTimeout(resolve, 120))
  }

  state.recording = false
  state.recordingPaused = false
  removeNavigationWatch()

  ws.send({ type: "record.stop" })
  await pushOverlayState()
}

/** Descarta a gravação: some com o overlay e com os passos capturados. */
async function cancelRecording(): Promise<void> {
  const tabId = state.recordingTabId
  const estavaGravando = state.recording
  if (estavaGravando && tabId !== undefined) {
    await sendRecordCommand(tabId, "stop").catch(() => undefined)
  }

  state.recording = false
  state.recordingPaused = false
  state.recordingSteps = 0
  state.recordingEvents = []
  state.recordedRecipe = undefined
  state.recordingConfirmed = false
  removeNavigationWatch()

  if (estavaGravando) ws.send({ type: "record.discard" })
  await pushOverlayState()
}

/** Manda o rascunho da gravação para o painel abrir o editor. */
async function openDraftInPanel(save = false): Promise<void> {
  const recipe = state.recordedRecipe
  if (!recipe) return

  broadcast(
    save
      ? { type: "panel:openAddScript", url: recipe.startUrl ?? "" }
      : { type: "panel:openEditor", recipe },
  )
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
  if (!state.recording) return
  state.recordingSteps += 1
  ws.send({ type: "record.event", event })
  void pushOverlayState()
}

/** Envia um comando de captura ao content script da aba gravada. */
async function sendRecordCommand(tabId: number, action: "start" | "pause" | "resume" | "stop"): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: INTERNAL.recordCommand,
      command: { action },
    })
  } catch {
    // a aba pode ter sido recarregada: o content script ainda não existe
    await injectRecorder(tabId)
    await chrome.tabs.sendMessage(tabId, {
      type: INTERNAL.recordCommand,
      command: { action },
    })
  }
}

// ── estado do overlay ───────────────────────────────────────────────────────

/** Monta o estado que o overlay desenha. */
function overlayState(): OverlayState {
  const hasDraft = state.recordedRecipe !== undefined
  return {
    visible: state.recording || hasDraft,
    recording: state.recording,
    paused: state.recordingPaused,
    steps: state.recordingSteps,
    events: state.recordingEvents,
    recipe: state.recordedRecipe,
    confirmed: state.recordingConfirmed,
  }
}

/** Manda o estado do overlay para a aba gravada. */
async function pushOverlayState(): Promise<void> {
  const tabId = state.recordingTabId ?? state.activeTabId
  if (tabId === undefined) return
  const payload = overlayState()
  try {
    await chrome.tabs.sendMessage(tabId, { type: INTERNAL.overlayState, state: payload })
  } catch {
    // a aba pode não ter content script ainda — ela pergunta depois
  }
  // o painel acompanha o mesmo estado
  broadcast({ type: "recording", recording: state.recording, paused: state.recordingPaused, steps: state.recordingSteps })
}

// ── navegação durante a gravação ────────────────────────────────────────────

/** Acompanha navigações da aba gravada para virar um passo `navigate`. */
function watchNavigation(tabId: number): void {
  state.recordingTabId = tabId
  chrome.webNavigation.onCommitted.removeListener(onNavigation)
  chrome.webNavigation.onCommitted.addListener(onNavigation)
  chrome.tabs.onUpdated.removeListener(onTabUpdated)
  chrome.tabs.onUpdated.addListener(onTabUpdated)
}

function removeNavigationWatch(): void {
  chrome.webNavigation.onCommitted.removeListener(onNavigation)
  chrome.tabs.onUpdated.removeListener(onTabUpdated)
}

function onNavigation(details: chrome.webNavigation.NavigationEvent): void {
  if (details.tabId !== state.recordingTabId || details.frameId !== 0) return
  if (!state.recording) return
  emitRecordEvent({ kind: "navigate", url: details.url, ts: Date.now() })
}

/**
 * Retoma a captura depois que a página recarrega.
 *
 * O content script novo pergunta o estado ao service worker e volta a
 * capturar sozinho — por isso não é preciso reinjetar nada aqui.
 */
function onTabUpdated(tabId: number, changeInfo: chrome.tabs.TabChangeInfo): void {
  if (changeInfo.status !== "complete") return
  if (tabId !== state.recordingTabId) return
  if (!state.recording) return
  void pushOverlayState()
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
      state.recordingSteps = Number(message.steps ?? 0)
      await pushOverlayState()
      return
    }

    case "record.step": {
      state.recordingEvents = [...state.recordingEvents, message.event as RecordedEvent].slice(-200)
      await pushOverlayState()
      return
    }

    case "record.finished": {
      state.recordedRecipe = message.recipe as Recipe | undefined
      state.recording = false
      state.recordingPaused = false
      removeNavigationWatch()
      await pushOverlayState()
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

/**
 * Portas dos painéis abertos.
 *
 * `chrome.runtime.sendMessage` do service worker não alcança outras páginas
 * de extensão, então o painel se anuncia por uma conexão dedicada — é por
 * ela que chegam os avisos e o rascunho da gravação.
 */
const panelPorts = new Set<chrome.runtime.Port>()

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "griver:panel") return
  panelPorts.add(port)
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port)
  })
})

function broadcast(message: PanelMessage): void {
  for (const port of panelPorts) {
    try {
      port.postMessage(message)
    } catch {
      panelPorts.delete(port)
    }
  }
  // o runtime ainda alcança as páginas que ainda não conectaram
  void chrome.runtime.sendMessage(message).catch(() => undefined)
}

// reidrata o estado quando o service worker é reativado
void connect()
