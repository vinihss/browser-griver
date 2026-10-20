import type {
  ChatMessagePayload,
  ProjectSummary,
  Recipe,
  RecipeSummary,
  RunSummary,
} from "@griver/core"
import type { ConnectionStatus } from "../background/ws-client.js"

export type TabId = "receitas" | "chat" | "ajustes"

export interface PermissionRequest {
  requestId: string
  action: string
  resources: string[]
  title?: string
}

export interface ToolCall {
  name: string
  state: "running" | "completed" | "error"
  input?: unknown
}

export interface AppState {
  status: ConnectionStatus
  serverUrl: string
  token: string
  tab: TabId
  projects: ProjectSummary[]
  recipes: RecipeSummary[]
  selectedProjectId: string
  selectedRecipeId: string
  recipeText: string
  recipeDirty: boolean
  /**
   * Geração do conteúdo do editor.
   *
   * O editor é redesenhado a cada estado novo, mas o textarea só reescreve o
   * valor quando a receita mudou — do contrário o cursor do usuário volta
   * ao começo a cada tecla. Uma gravação que chega com passos novos é
   * conteúdo novo na MESMA receita: sem esta contagem, o editor continuaria
   * mostrando o texto antigo.
   */
  recipeEpoch: number
  recipeTarget: "browser" | "os"
  recipeIssues: { path: string; message: string; severity: string }[]
  recording: { active: boolean; paused: boolean; steps: number }
  chatSessionId: string
  chatMessages: ChatMessagePayload[]
  chatTools: ToolCall[]
  chatPermission: PermissionRequest | undefined
  chatDraft: string
  /** texto digitado antes de existir uma sessão; enviado assim que ela abre */
  chatPending: string
  runs: RunSummary[]
  runEvents: { path: string; type: string; status: string; error?: string }[]
  notice: { text: string; kind: "info" | "error" } | undefined
  busy: boolean
  /** modal "Add New Script" aberto */
  showAddScript: boolean
  /**
   * Receita sendo editada sem estar salva no servidor.
   *
   * É o que a gravação produz: o `✎` do overlay abre este rascunho no editor
   * para o usuário ajustar antes de salvar.
   */
  draftRecipe: Recipe | undefined
}

export const state: AppState = {
  status: "offline",
  serverUrl: "http://127.0.0.1:7331",
  token: "",
  tab: "receitas",
  projects: [],
  recipes: [],
  selectedProjectId: "",
  selectedRecipeId: "",
  recipeText: "",
  recipeDirty: false,
  recipeEpoch: 0,
  recipeTarget: "browser",
  recipeIssues: [],
  recording: { active: false, paused: false, steps: 0 },
  chatSessionId: "",
  chatMessages: [],
  chatTools: [],
  chatPermission: undefined,
  chatDraft: "",
  chatPending: "",
  runs: [],
  runEvents: [],
  notice: undefined,
  busy: false,
  showAddScript: false,
  draftRecipe: undefined,
}

type Listener = () => void
const listeners = new Set<Listener>()

export function subscribe(listener: Listener): void {
  listeners.add(listener)
}

export function notify(): void {
  for (const listener of listeners) listener()
}

export function patch(partial: Partial<AppState>): void {
  Object.assign(state, partial)
  notify()
}

export function setNotice(text: string, kind: "info" | "error" = "info"): void {
  state.notice = { text, kind }
  notify()
  setTimeout(() => {
    if (state.notice?.text === text) {
      state.notice = undefined
      notify()
    }
  }, 4000)
}
