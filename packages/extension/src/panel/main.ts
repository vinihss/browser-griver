import { mount } from "./app.js"
import { state, patch, setNotice } from "./state.js"
import { refreshProjects } from "./views/projects.js"
import {
  enderecoDoServidor,
  esconderAvisoDeServidor,
  mostrarAvisoDeServidor,
  servidorResponde,
} from "./server-notice.js"

const root = document.getElementById("root")
if (!root) throw new Error("elemento #root não encontrado")

mount(root)

/**
 * Liga o painel ao servidor.
 *
 * A ordem importa. O endereço e o token saem do storage, mas o token é
 * confirmado pelo service worker: ele o busca no servidor atual a cada
 * consulta, e o que está no storage pode ser de outro servidor — ou de antes
 * de o servidor trocar de token. Usar o token guardado como se fosse o
 * certo leva 401 em toda chamada, e o painel abre vazio sem dizer o motivo.
 */
async function iniciar(): Promise<void> {
  // recupera as configurações salvas
  const stored = await chrome.storage.local.get(["griver.serverUrl", "griver.token"])
  if (stored["griver.serverUrl"]) state.serverUrl = stored["griver.serverUrl"] as string
  if (stored["griver.token"]) state.token = stored["griver.token"] as string
  patch({})

  // status inicial (o service worker garante o token antes de responder)
  const response = (await chrome.runtime.sendMessage({ type: "panel:status" })) as {
    status?: string
    token?: string
  }
  if (response?.status) patch({ status: response.status as never })
  if (response?.token) patch({ token: response.token })
  patch({})

  // sempre carregar projetos ao abrir o painel, para que projetos gravados
  // sejam carregados automaticamente
  await refreshProjects()

  // Verificar se o servidor está respondendo
  await verificarServidorConectado()
}

void iniciar().catch(() => undefined)

/**
 * Verifica se o servidor está respondendo.
 *
 * Se não estiver, mostra a tela que bloqueia o painel até o servidor
 * voltar — e some com ela assim que ele responde.
 */
async function verificarServidorConectado(): Promise<void> {
  const url = enderecoDoServidor()

  if (await servidorResponde(url)) {
    patch({ notice: undefined })
    esconderAvisoDeServidor()
    return
  }

  // a mensagem do navegador ("Failed to fetch") não diz nada: o que o
  // usuário precisa saber é onde o servidor não respondeu
  setNotice(`Não foi possível conectar ao servidor Griver em ${url}.`, "error")
  mostrarAvisoDeServidor(url)
}
