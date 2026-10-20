export const DEFAULT_SERVER_URL = "http://127.0.0.1:7331"
export const WS_PATH = "/ws"

export const STORAGE = {
  serverUrl: "griver.serverUrl",
  token: "griver.token",
  recording: "griver.recording",
  activeTab: "griver.activeTab",
  chatSession: "griver.chatSession",
  defaultProjectId: "griver.defaultProjectId",
} as const

export const EXTENSION_VERSION = "0.1.0"

/** Mensagens internas entre os componentes da extensão. */
export const INTERNAL = {
  recordCommand: "griver:record",
  recordEvent: "griver:record-event",
  execute: "griver:execute",
  executeResult: "griver:execute-result",
  pageCommand: "griver:page",
  pageResult: "griver:page-result",
  stateChanged: "griver:state",
  captureScreenshot: "griver:screenshot",
  /** content script pergunta o que deve exibir */
  overlayQuery: "griver:overlay-query",
  /** content script ou painel pedem uma ação do overlay */
  overlayCommand: "griver:overlay-command",
  /** service worker manda o estado para o overlay desenhar */
  overlayState: "griver:overlay-state",
} as const

/** Ações do overlay de gravação (a barra de controle na página). */
export type OverlayAction = "start" | "pause" | "resume" | "stop" | "cancel"
