import type { ClientMessage } from "@griver/core"

/** Envia uma mensagem ao servidor através do service worker. */
export function sendToServer(payload: ClientMessage): void {
  void chrome.runtime.sendMessage({ type: "panel:send", payload })
}

/** Envia um comando ao service worker. */
export function toBackground(message: Record<string, unknown>): Promise<unknown> {
  return chrome.runtime.sendMessage(message) as Promise<unknown>
}

/** Pede ao service worker para executar um comando de gravação. */
export function recordCommand(action: "start" | "pause" | "resume" | "stop" | "discard"): void {
  void toBackground({ type: "panel:record", action })
}

/** Avisa o service worker qual projeto está em uso. */
export function setActiveProject(projectId: string): void {
  void toBackground({ type: "panel:project", projectId })
}
