import type { ChatMessagePayload } from "@griver/core"
import type { Repository } from "../db/repo.js"
import {
  OpenCodeClient,
  type OpenCodeEvent,
  type PermissionRequest,
} from "./client.js"

export interface ChatBridgeHandlers {
  onMessage?: (sessionId: string, message: ChatMessagePayload) => void
  onTool?: (sessionId: string, toolName: string, state: "running" | "completed" | "error", input?: unknown) => void
  onPermission?: (sessionId: string, request: PermissionRequest) => void
  onError?: (sessionId: string, message: string) => void
  onSessionClosed?: (sessionId: string) => void
}

export interface ChatSessionInfo {
  id: string
  title: string
  createdAt: number
  opencodeSessionId?: string
}

/**
 * Ponte entre o chat da extensão e o servidor local do OpenCode.
 *
 * Mantém uma única assinatura SSE para todas as conversas e repassa apenas os
 * eventos das sessões relevantes, já normalizados para a interface.
 */
export class ChatBridge {
  private subscription: Promise<void> | undefined
  private readonly buffers = new Map<string, string>()
  /** sessões com execução em andamento */
  private readonly executing = new Set<string>()

  constructor(
    private readonly client: OpenCodeClient,
    private readonly repo: Repository,
    private readonly handlers: ChatBridgeHandlers = {},
  ) {}

  /**
   * Garante que o fluxo de eventos do OpenCode esteja conectado.
   *
   * Não aguarda o fim da assinatura — a conexão é de longa duração e fica
   * aberta em segundo plano.
   */
  ensureSubscribed(): void {
    if (this.subscription) return
    const controller = new AbortController()
    this.subscription = this.client
      .subscribe((event) => this.handleEvent(event), controller.signal)
      .catch((error) => {
        this.subscription = undefined
        console.error("[chat] assinatura de eventos interrompida:", error)
      })
  }

  /** Cria uma conversa no Griver e a sessão correspondente no OpenCode. */
  async createSession(input: { projectId?: string; title?: string; directory?: string } = {}): Promise<ChatSessionInfo> {
    const local = this.repo.createChatSession({
      projectId: input.projectId,
      title: input.title,
    })

    try {
      this.ensureSubscribed()
      const remote = await this.client.createSession({
        title: input.title ?? "Griver",
        directory: input.directory ?? process.cwd(),
        agent: "griver",
      })
      this.repo.setChatOpencodeSession(local.id, remote.id, input.title)
      return {
        id: local.id,
        title: input.title ?? local.title,
        createdAt: local.createdAt,
        opencodeSessionId: remote.id,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.handlers.onError?.(local.id, message)
      return {
        id: local.id,
        title: input.title ?? local.title,
        createdAt: local.createdAt,
      }
    }
  }

  async send(sessionId: string, text: string): Promise<void> {
    const local = this.repo.getChatSession(sessionId)
    if (!local) throw new Error("conversa não encontrada")

    const remoteId = local.opencodeSessionId
    if (!remoteId) {
      throw new Error("a conversa ainda não está vinculada a uma sessão do OpenCode")
    }

    this.handlers.onMessage?.(sessionId, {
      id: `local_${Date.now()}`,
      role: "user",
      text,
      createdAt: Date.now(),
    })

    this.ensureSubscribed()
    await this.client.prompt(remoteId, text)
  }

  async replyPermission(
    sessionId: string,
    requestId: string,
    decision: "once" | "always" | "reject",
    feedback?: string,
  ): Promise<void> {
    const local = this.repo.getChatSession(sessionId)
    if (!local?.opencodeSessionId) throw new Error("conversa não encontrada")
    await this.client.replyPermission(local.opencodeSessionId, requestId, decision, feedback)
  }

  async interrupt(sessionId: string): Promise<void> {
    const local = this.repo.getChatSession(sessionId)
    if (!local?.opencodeSessionId) return
    await this.client.interrupt(local.opencodeSessionId)
  }

  listSessions(): ChatSessionInfo[] {
    return this.repo.listChatSessions().map((session) => ({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
    }))
  }

  /** Indica se o assistente ainda está trabalhando nesta conversa. */
  isExecuting(sessionId: string): boolean {
    return this.executing.has(sessionId)
  }

  /** Traduz um evento do OpenCode em algo que a interface entende. */
  private handleEvent(event: OpenCodeEvent): void {
    const data = event.data ?? {}
    const sessionId = readString(data, "sessionID")
    if (!sessionId) return

    const remoteId = this.remoteIdFor(sessionId)
    if (!remoteId) return

    switch (event.type) {
      case "session.execution.started": {
        this.executing.add(remoteId)
        break
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        this.executing.delete(remoteId)
        break
      }
      case "session.text.started": {
        this.buffers.set(remoteId, "")
        break
      }
      case "session.text.delta": {
        const delta = readString(data, "delta") ?? ""
        const current = (this.buffers.get(remoteId) ?? "") + delta
        this.buffers.set(remoteId, current)
        this.handlers.onMessage?.(remoteId, {
          id: readString(data, "assistantMessageID") ?? remoteId,
          role: "assistant",
          text: delta,
          createdAt: Date.now(),
          partial: true,
        })
        break
      }
      case "session.text.ended": {
        const text = readString(data, "text") ?? this.buffers.get(remoteId) ?? ""
        this.buffers.delete(remoteId)
        this.handlers.onMessage?.(remoteId, {
          id: readString(data, "assistantMessageID") ?? remoteId,
          role: "assistant",
          text,
          createdAt: Date.now(),
        })
        break
      }
      case "session.tool.called":
      case "session.tool.input": {
        const toolName = readString(data, "tool") ?? readString(data, "toolName") ?? readString(data, "name") ?? "tool"
        this.handlers.onTool?.(remoteId, toolName, "running", data.input ?? data.args ?? data.arguments)
        break
      }
      case "session.tool.progress": {
        const toolName = readString(data, "tool") ?? readString(data, "toolName") ?? "tool"
        this.handlers.onTool?.(remoteId, toolName, "running", data)
        break
      }
      case "session.tool.success":
      case "session.tool.completed": {
        const toolName = readString(data, "tool") ?? readString(data, "toolName") ?? "tool"
        this.handlers.onTool?.(remoteId, toolName, "completed", data.output ?? data.result)
        break
      }
      case "session.tool.failed": {
        const toolName = readString(data, "tool") ?? readString(data, "toolName") ?? "tool"
        this.handlers.onTool?.(remoteId, toolName, "error", data.error ?? data)
        break
      }
      case "session.permission.create": {
        this.handlers.onPermission?.(remoteId, {
          id: readString(data, "id") ?? readString(data, "requestID") ?? "",
          sessionID: remoteId,
          action: readString(data, "action") ?? "executar",
          resources: Array.isArray(data.resources) ? (data.resources as string[]) : [],
          save: Array.isArray(data.save) ? (data.save as string[]) : undefined,
          metadata: data.metadata as Record<string, unknown> | undefined,
          message: readString(data, "message"),
        })
        break
      }
      case "session.execution.failed": {
        const message = readString(data, "message") ?? readString(data, "error") ?? "falha na execução"
        this.handlers.onError?.(remoteId, message)
        break
      }
      case "session.execution.interrupted": {
        this.handlers.onSessionClosed?.(remoteId)
        break
      }
    }
  }
  /** Converte o id remoto do OpenCode no id local da conversa. */
  private remoteIdFor(remoteSessionId: string): string | undefined {
    for (const session of this.repo.listChatSessions()) {
      const local = this.repo.getChatSession(session.id)
      if (local?.opencodeSessionId === remoteSessionId) return session.id
    }
    return undefined
  }
}

function readString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  return undefined
}
