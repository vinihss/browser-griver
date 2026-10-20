export const DEFAULT_SERVER_URL = "http://127.0.0.1:7331"
export const WS_PATH = "/ws"

export const STORAGE = {
  serverUrl: "griver.serverUrl",
  token: "griver.token",
  recording: "griver.recording",
  activeTab: "griver.activeTab",
  chatSession: "griver.chatSession",
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
} as const
