import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export interface OpenCodeEvent {
  id?: string
  type: string
  created?: number
  location?: { directory?: string }
  data?: Record<string, unknown>
  properties?: Record<string, unknown>
}

export interface OpenCodeSession {
  id: string
  title?: string
  location?: { directory?: string }
}

export interface OpenCodeModel {
  providerID: string
  id: string
  name: string
}

export interface PermissionRequest {
  id: string
  sessionID: string
  action: string
  resources: string[]
  save?: string[]
  metadata?: Record<string, unknown>
  message?: string
}

export class OpenCodeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = "OpenCodeError"
  }
}

/**
 * Cliente HTTP do servidor local do OpenCode.
 *
 * O serviço exige autenticação Basic — a senha fica em
 * `~/.config/opencode/service.json`. O endpoint é dinâmico, então é
 * descoberta rodando `opencode service status`.
 */
export class OpenCodeClient {
  private endpoint: string | undefined
  private authHeader: string | undefined

  constructor(private readonly configDir: string) {}

  /** Descobre o endpoint do serviço local. Retorna undefined se não estiver no ar. */
  async discover(): Promise<string | undefined> {
    if (this.endpoint) return this.endpoint
    try {
      const { stdout } = await execFileAsync("opencode", ["service", "status"], { timeout: 10_000 })
      const lines = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
      const candidate = lines[lines.length - 1]
      if (candidate && /^https?:\/\//.test(candidate)) {
        this.endpoint = candidate
        return this.endpoint
      }
    } catch {
      // serviço indisponível
    }
    return undefined
  }

  /** Tenta iniciar o serviço local do OpenCode. */
  async start(): Promise<boolean> {
    try {
      await execFileAsync("opencode", ["serve", "--service"], { timeout: 8_000 })
    } catch {
      // o processo pode continuar em segundo plano mesmo com timeout
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const endpoint = await this.discover()
      if (endpoint) return true
    }
    return false
  }

  private getAuthHeader(): string {
    if (this.authHeader) return this.authHeader
    const path = join(this.configDir, "service.json")
    if (!existsSync(path)) {
      throw new OpenCodeError(`credenciais do OpenCode não encontradas em ${path}`)
    }
    const { password } = JSON.parse(readFileSync(path, "utf8")) as { password: string }
    this.authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
    return this.authHeader
  }

  private async url(path: string): Promise<string> {
    const endpoint = await this.discover()
    if (!endpoint) {
      throw new OpenCodeError("serviço local do OpenCode não está rodando")
    }
    return `${endpoint}${path}`
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(await this.url(path), {
      ...init,
      headers: {
        Authorization: this.getAuthHeader(),
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    })
    const text = await response.text()
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        const parsed = JSON.parse(text) as { message?: string; error?: string }
        message = parsed.message ?? parsed.error ?? message
      } catch {
        /* resposta não-JSON */
      }
      throw new OpenCodeError(message, response.status)
    }
    if (!text) return undefined as T
    try {
      const parsed = JSON.parse(text) as { data?: T } & T
      return (parsed as { data?: T }).data ?? (parsed as T)
    } catch {
      return text as unknown as T
    }
  }

  async info(): Promise<{ version: string }> {
    return await this.request<{ version: string }>("/api/info")
  }

  async createSession(input: { title?: string; directory?: string; agent?: string }): Promise<OpenCodeSession> {
    return await this.request<OpenCodeSession>("/api/session", {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        agent: input.agent,
        location: input.directory ? { directory: input.directory } : undefined,
      }),
    })
  }

  async deleteSession(sessionID: string): Promise<void> {
    await this.request(`/api/session/${sessionID}`, { method: "DELETE" })
  }

  async prompt(sessionID: string, text: string): Promise<unknown> {
    return await this.request(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text }),
    })
  }

  async interrupt(sessionID: string): Promise<void> {
    await this.request(`/api/session/${sessionID}/interrupt`, { method: "POST" })
  }

  async messages(sessionID: string): Promise<unknown[]> {
    const result = await this.request<unknown>(`/api/session/${sessionID}/message`)
    if (Array.isArray(result)) return result
    if (result && typeof result === "object") {
      const maybe = (result as { messages?: unknown[] }).messages
      if (Array.isArray(maybe)) return maybe
    }
    return []
  }

  async models(): Promise<OpenCodeModel[]> {
    try {
      const result = await this.request<unknown[]>("/api/model")
      if (!Array.isArray(result)) return []
      return result
        .map((entry) => {
          const model = entry as { id?: string; providerID?: string; name?: string }
          if (!model.id || !model.providerID) return undefined
          return { providerID: model.providerID, id: model.id, name: model.name ?? model.id }
        })
        .filter((m): m is OpenCodeModel => Boolean(m))
    } catch {
      return []
    }
  }

  async listPermissions(sessionID: string): Promise<PermissionRequest[]> {
    try {
      const result = await this.request<unknown>(`/api/session/${sessionID}/permission`)
      if (Array.isArray(result)) return result as PermissionRequest[]
      return []
    } catch {
      return []
    }
  }

  async replyPermission(
    sessionID: string,
    requestID: string,
    decision: "once" | "always" | "reject",
    message?: string,
  ): Promise<void> {
    await this.request(`/api/session/${sessionID}/permission/${requestID}/reply`, {
      method: "POST",
      body: JSON.stringify({ decision, message }),
    })
  }

  /**
   * Assina o fluxo de eventos do servidor.
   *
   * A conexão é mantida viva até que o `signal` seja abortado.
   */
  async subscribe(
    onEvent: (event: OpenCodeEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetch(await this.url("/api/event"), {
      headers: { Authorization: this.getAuthHeader(), Accept: "text/event-stream" },
      signal,
    })
    if (!response.ok || !response.body) {
      throw new OpenCodeError(`falha ao assinar eventos (HTTP ${response.status})`, response.status)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let boundary = buffer.indexOf("\n\n")
        while (boundary !== -1) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const dataLine = chunk.split("\n").find((line) => line.startsWith("data:"))
          if (dataLine) {
            const payload = dataLine.slice(5).trim()
            if (payload) {
              try {
                onEvent(JSON.parse(payload) as OpenCodeEvent)
              } catch {
                /* payload malformado é ignorado */
              }
            }
          }
          boundary = buffer.indexOf("\n\n")
        }
      }
    } catch (error) {
      if (signal.aborted) return
      throw error
    }
  }
}
