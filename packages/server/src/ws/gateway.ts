import type { Server as HttpServer } from "node:http"
import { WebSocketServer, type WebSocket } from "ws"
import {
  decode,
  encode,
  type ClientMessage,
  type PageActionRequest,
  type PageActionResult,
  type ServerMessage,
} from "@griver/core"

export interface ClientConnection {
  id: string
  socket: WebSocket
  authenticated: boolean
  info: { version?: string }
}

export interface GatewayHandlers {
  onMessage?: (client: ClientConnection, message: ClientMessage) => void | Promise<void>
  onConnect?: (client: ClientConnection) => void
  onDisconnect?: (client: ClientConnection) => void
  /** versão do servidor, confirmada no handshake (`hello.ok`) */
  serverVersion?: string
}

/**
 * Gateway WebSocket da extensão.
 *
 * Mantém as conexões abertas, distribui eventos e resolve requisições
 * pendentes (servidor → extensão → resposta) por identificador de correlação.
 */
export class WsGateway {
  private readonly clients = new Map<string, ClientConnection>()
  private readonly pending = new Map<
    string,
    { resolve: (result: PageActionResult) => void; timer: NodeJS.Timeout }
  >()
  private counter = 0
  private readonly wss: WebSocketServer

  constructor(
    server: HttpServer,
    private readonly token: string,
    private readonly handlers: GatewayHandlers = {},
  ) {
    this.wss = new WebSocketServer({ server, path: "/ws" })

    // o ws repassa erros do servidor HTTP; sem este handler o processo cai
    this.wss.on("error", (error) => {
      console.error("[ws] erro no servidor de WebSocket:", error)
    })

    this.wss.on("connection", (socket: WebSocket) => {
      const id = `c${++this.counter}`
      const client: ClientConnection = { id, socket, authenticated: false, info: {} }
      this.clients.set(id, client)

      socket.on("message", (raw) => {
        let message: ClientMessage
        try {
          message = decode<ClientMessage>(raw.toString())
        } catch {
          this.send(client, { type: "error", message: "mensagem inválida" })
          return
        }
        void this.handleMessage(client, message)
      })

      socket.on("close", () => {
        this.clients.delete(id)
        this.handlers.onDisconnect?.(client)
      })

      socket.on("error", () => {
        this.clients.delete(id)
      })

      this.handlers.onConnect?.(client)
    })
  }

  private async handleMessage(client: ClientConnection, message: ClientMessage): Promise<void> {
    if (message.type === "hello") {
      if (message.token !== this.token) {
        this.send(client, { type: "error", message: "token inválido" })
        client.socket.close()
        return
      }
      client.authenticated = true
      client.info.version = message.clientVersion
      // confirma o handshake: sem isso a extensão não sabe se o token
      // aceito, e quem fala com o servidor pela API também não tem como
      // saber que a extensão já está autenticada
      this.send(client, {
        type: "hello.ok",
        serverVersion: this.handlers.serverVersion ?? "0.0.0",
      })
      return
    }

    if (!client.authenticated) {
      this.send(client, { type: "error", message: "conexão não autenticada" })
      return
    }

    // resposta a uma requisição pendente
    if (message.type === "page.result") {
      const pending = this.pending.get(message.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        pending.resolve(message.result)
        return
      }
    }

    await this.handlers.onMessage?.(client, message)
  }

  /** Envia uma mensagem para uma conexão específica. */
  send(client: ClientConnection, message: ServerMessage): void {
    if (client.socket.readyState !== client.socket.OPEN) return
    client.socket.send(encode(message))
  }

  /**
   * Devolve a primeira extensão autenticada e conectada.
   *
   * É o alvo padrão de comandos que precisam de uma única aba — rodar uma
   * receita na aba de uma extensão não pode ser entregue a todas, senão
   * cada uma delas executa na sua aba ativa.
   */
  firstAuthenticatedClient(): ClientConnection | undefined {
    for (const client of this.clients.values()) {
      if (!client.authenticated) continue
      if (client.socket.readyState !== client.socket.OPEN) continue
      return client
    }
    return undefined
  }

  /** Envia uma mensagem para todas as extensões conectadas. */
  broadcast(message: ServerMessage): void {
    const payload = encode(message)
    for (const client of this.clients.values()) {
      if (!client.authenticated) continue
      if (client.socket.readyState !== client.socket.OPEN) continue
      client.socket.send(payload)
    }
  }

  /**
   * Envia um comando para a extensão e aguarda a resposta.
   *
   * Usado pelo chat para inspecionar e manipular a aba ativa.
   */
  request(request: PageActionRequest, timeoutMs = 30_000): Promise<PageActionResult> {
    const targets = [...this.clients.values()].filter((client) => client.authenticated)
    if (!targets.length) {
      return Promise.resolve({ ok: false, error: "nenhuma extensão conectada" })
    }

    return new Promise<PageActionResult>((resolve) => {
      const id = `req_${Date.now()}_${++this.counter}`
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: "tempo esgotado aguardando a extensão" })
      }, timeoutMs)

      this.pending.set(id, { resolve, timer })
      this.send(targets[0]!, { type: "page.request", id, request })
    })
  }

  get connectionCount(): number {
    return [...this.clients.values()].filter((client) => client.authenticated).length
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) {
      try {
        client.socket.close()
      } catch {
        /* ignora */
      }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()))
  }
}
