import type { ClientMessage, ServerMessage } from "@griver/core"
import { decode, encode } from "@griver/core/protocol"
import { DEFAULT_SERVER_URL, WS_PATH } from "../shared/constants.js"

export type ConnectionStatus = "offline" | "connecting" | "online"

export interface WsClientOptions {
  getUrl: () => Promise<{ url: string; token: string }>
  onMessage: (message: ServerMessage) => void
  onStatus: (status: ConnectionStatus) => void
}

/**
 * Cliente WebSocket do service worker.
 *
 * Reconecta com recuo exponencial e envia um ping periódico — a conexão
 * aberta também mantém o service worker vivo, algo essencial no MV3.
 */
export class WsClient {
  private socket: WebSocket | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private attempts = 0
  private closed = false
  private queue: ClientMessage[] = []
  /** conexão em andamento — evita abrir dois sockets ao mesmo tempo */
  private pending: Promise<void> | undefined

  constructor(private readonly options: WsClientOptions) {}

  get status(): ConnectionStatus {
    if (!this.socket) return "offline"
    return this.socket.readyState === WebSocket.OPEN ? "online" : "connecting"
  }

  async connect(): Promise<void> {
    this.closed = false
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return

    // duas chamadas concorrentes compartilhariam a mesma promessa: sem isso,
    // cada uma abriria um socket e o servidor passaria a enviar os mesmos
    // eventos duas vezes — duplicando passos na gravação
    if (this.pending) return this.pending
    this.pending = this.openSocket().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  private async openSocket(): Promise<void> {
    this.options.onStatus("connecting")

    const { url, token } = await this.options.getUrl()
    const target = `${url.replace(/^http/, "ws").replace(/\/$/, "")}${WS_PATH}`

    try {
      const socket = new WebSocket(target)
      this.socket = socket

      socket.onopen = () => {
        this.attempts = 0
        this.options.onStatus("online")
        socket.send(encode({ type: "hello", token, clientVersion: "0.1.0" }))
        for (const message of this.queue.splice(0)) socket.send(encode(message))
        this.startHeartbeat()
      }

      socket.onmessage = (event) => {
        try {
          this.options.onMessage(decode<ServerMessage>(String(event.data)))
        } catch {
          /* mensagem malformada é ignorada */
        }
      }

      socket.onclose = () => {
        this.stopHeartbeat()
        if (this.socket === socket) this.socket = undefined
        this.options.onStatus("offline")
        if (!this.closed) this.scheduleReconnect()
      }

      socket.onerror = () => {
        socket.close()
      }
    } catch {
      this.options.onStatus("offline")
      if (!this.closed) this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    this.attempts += 1
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.attempts, 6))
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.connect()
    }, delay)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(encode({ type: "ping" }))
      }
    }, 15_000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encode(message))
      return
    }
    // enfileira para enviar assim que reconectar
    this.queue.push(message)
    if (this.queue.length > 200) this.queue.shift()
    void this.connect()
  }

  close(): void {
    this.closed = true
    clearTimeout(this.timer)
    this.stopHeartbeat()
    this.socket?.close()
    this.socket = undefined
  }
}

export { DEFAULT_SERVER_URL }
