import type { Recipe, TargetKind } from "../recipe/schema.js"
import type { StepEvent } from "../runtime/interpreter.js"

/**
 * Protocolo da conexão WebSocket entre a extensão e o servidor local.
 *
 * Todas as mensagens carregam `type`. Mensagens que espera resposta usam `id`
 * como identificador de correlação (a resposta reusa o mesmo `id`).
 */

export interface ProjectSummary {
  id: string
  name: string
  description: string | null
  createdAt: number
  updatedAt: number
  recipeCount?: number
}

export interface RecipeSummary {
  id: string
  projectId: string
  name: string
  target: TargetKind
  createdAt: number
  updatedAt: number
  stepCount?: number
}

export interface RecordedEvent {
  kind: "click" | "input" | "change" | "select" | "submit" | "keydown" | "navigate" | "scroll"
  url?: string
  selector?: string
  selectors?: string[]
  text?: string
  value?: string
  key?: string
  ts: number
}

export type RecordingState = "idle" | "recording" | "paused"

export interface RunSummary {
  id: string
  recipeId: string
  recipeName?: string
  driver: string
  status: "queued" | "running" | "ok" | "error" | "aborted"
  startedAt: number
  endedAt?: number
  error?: string
  scope?: Record<string, unknown>
}

export interface ChatMessagePayload {
  id: string
  role: "user" | "assistant" | "system" | "tool"
  text: string
  createdAt: number
  toolName?: string
  toolState?: "running" | "completed" | "error"
  /** true quando é um fragmento de streaming, ainda sujeito a revisão */
  partial?: boolean
}

export interface PageActionRequest {
  /** `context` | `click` | `fill` | `screenshot` */
  action: "context" | "click" | "fill" | "screenshot" | "evaluate"
  payload?: Record<string, unknown>
}

export interface PageActionResult {
  ok: boolean
  result?: unknown
  error?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// extensão → servidor
// ─────────────────────────────────────────────────────────────────────────────

export type ClientMessage =
  | { type: "hello"; token: string; clientVersion?: string }
  | { type: "project.list" }
  | { type: "project.create"; name: string; description?: string }
  | { type: "project.update"; id: string; patch: Partial<Pick<ProjectSummary, "name" | "description">> }
  | { type: "project.delete"; id: string }
  | { type: "recipe.list"; projectId?: string }
  | { type: "recipe.create"; projectId: string; name: string; target: TargetKind; recipe: Recipe }
  | {
      type: "recipe.update"
      id: string
      patch: Partial<Pick<RecipeSummary, "name" | "target">> & { recipe?: Recipe }
    }
  | { type: "recipe.delete"; id: string }
  | { type: "record.start"; projectId: string; tabId?: number }
  | { type: "record.pause" }
  | { type: "record.resume" }
  | { type: "record.stop" }
  | { type: "record.discard" }
  | { type: "record.event"; event: RecordedEvent }
  | { type: "run.start"; recipeId: string; driver?: string; vars?: Record<string, unknown> }
  | { type: "run.cancel"; runId: string }
  | {
      type: "run.result"
      runId: string
      status: "ok" | "error" | "aborted"
      events: StepEvent[]
      error?: string
      scope?: Record<string, unknown>
    }
  | { type: "chat.create"; projectId?: string }
  | { type: "chat.send"; sessionId: string; text: string }
  | { type: "chat.list" }
  | { type: "page.result"; id: string; result: PageActionResult }
  | { type: "permission.reply"; sessionId: string; requestId: string; reply: "once" | "always" | "reject"; feedback?: string }
  | { type: "ping" }

// ─────────────────────────────────────────────────────────────────────────────
// servidor → extensão
// ─────────────────────────────────────────────────────────────────────────────

export type ServerMessage =
  | {
      type: "hello.ok"
      serverVersion: string
      opencode: { available: boolean; models?: { providerID: string; id: string; name: string }[] }
    }
  | { type: "error"; id?: string; message: string }
  | { type: "pong" }
  | { type: "projects"; projects: ProjectSummary[] }
  | { type: "project"; project: ProjectSummary }
  | { type: "recipes"; recipes: RecipeSummary[] }
  | { type: "recipe"; recipe: RecipeSummary; body?: Recipe }
  | { type: "projects.changed" }
  | { type: "recipes.changed" }
  | { type: "record.state"; state: RecordingState; steps: number; projectId?: string }
  | { type: "record.step"; event: RecordedEvent }
  | { type: "record.finished"; recipeId?: string; stepCount: number; recipe?: Recipe }
  | { type: "run.started"; run: RunSummary }
  | { type: "run.event"; runId: string; event: StepEvent }
  | { type: "run.finished"; run: RunSummary }
  | { type: "run.request"; runId: string; recipeId: string; recipe: Recipe; vars?: Record<string, unknown> }
  | { type: "chat.sessions"; sessions: { id: string; title: string; createdAt: number }[] }
  | { type: "chat.message"; sessionId: string; message: ChatMessagePayload }
  | { type: "chat.tool"; sessionId: string; toolName: string; state: "running" | "completed" | "error"; input?: unknown }
  | { type: "chat.permission"; requestId: string; action: string; resources: string[]; title?: string }
  | { type: "page.request"; id: string; request: PageActionRequest }
  | { type: "data"; id: string; payload: unknown }

export function encode(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message)
}

export function decode<T = ClientMessage | ServerMessage>(raw: string): T {
  return JSON.parse(raw) as T
}
