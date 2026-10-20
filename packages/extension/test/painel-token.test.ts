/**
 * O painel se recupera sozinho de um 401.
 *
 * O token guardado é do servidor anterior: o painel abre, pede as receitas
 * e o servidor recusa. Ele tem que buscar o token novo com o service
 * worker e repetir a chamada — sem a mão do usuário.
 *
 * Aqui o `chrome` e o `fetch` são de mentira: o service worker responde (ou
 * não) na hora que o teste quer, e o servidor recusa o token velho na
 * primeira chamada. Sem browser, sem corrida: o comportamento que importa
 * fica testado de forma determinística.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { loadProjects } from "../src/panel/api.js"
import { state } from "../src/panel/state.js"

/** Resposta de fetch montada à mão. */
interface RespostaFake {
  ok: boolean
  status: number
  text(): Promise<string>
}

function resposta(status: number, corpo?: unknown): RespostaFake {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (corpo === undefined ? "" : JSON.stringify(corpo)),
  }
}

/** O que o service worker responde a cada mensagem. */
type RespostasDoServiceWorker = (string | undefined)[]

/**
 * Roda uma ação do painel com o `chrome` e o `fetch` de mentira.
 *
 * Devolve o token que foi em cada chamada — é por aí que se vê se o
 * painel repetiu a chamada com o token certo.
 */
async function comFakes(
  tokenGuardado: string,
  respostasDoServiceWorker: RespostasDoServiceWorker,
  respostas: RespostaFake[],
  acao: () => Promise<unknown>,
): Promise<string[]> {
  const enviados: string[] = []
  let mensagens = 0
  let chamadas = 0

  const chrome = {
    runtime: {
      sendMessage: async () => {
        const token = respostasDoServiceWorker[mensagens]
        mensagens++
        // undefined: o service worker não respondeu (dormindo ou subindo)
        if (token === undefined) throw new Error("service worker indisponível")
        return { ok: true, token }
      },
    },
    storage: {
      local: { get: async () => ({}), set: async () => undefined },
    },
  }

  const fetchOriginal = globalThis.fetch
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    enviados.push(headers["X-Griver-Token"] ?? "")
    const resposta = respostas[chamadas]
    chamadas++
    if (!resposta) throw new Error("o teste não previu essa chamada")
    return resposta as unknown as Response
  }) as typeof fetch

  ;(globalThis as Record<string, unknown>).chrome = chrome
  state.serverUrl = "http://127.0.0.1:7331"
  // o token guardado é o do servidor anterior: é com ele que o painel abre
  state.token = tokenGuardado

  try {
    await acao()
  } finally {
    globalThis.fetch = fetchOriginal
    delete (globalThis as Record<string, unknown>).chrome
  }

  return enviados
}

test("um 401 faz o painel buscar o token novo e repetir a chamada", async () => {
  const enviados = await comFakes(
    "token-velho",
    ["token-novo"],
    [resposta(401, { error: "token inválido" }), resposta(200, { projects: [] })],
    async () => {
      await loadProjects()
    },
  )

  assert.deepEqual(enviados, ["token-velho", "token-novo"])
})

test("o painel se recupera mesmo com o service worker atrasado", async () => {
  const enviados = await comFakes(
    "token-velho",
    // a primeira mensagem não tem resposta: o service worker ainda está
    // subindo ou ocupado com a renovação do token
    [undefined, "token-novo"],
    [resposta(401, { error: "token inválido" }), resposta(200, { projects: [] })],
    async () => {
      await loadProjects()
    },
  )

  assert.deepEqual(enviados, ["token-velho", "token-novo"])
})

test("o painel repete a chamada mesmo que o token não tenha mudado", async () => {
  const enviados = await comFakes(
    "token-velho",
    // o service worker devolve o mesmo token: a renovação ainda não acabou
    ["token-velho"],
    [resposta(401, { error: "token inválido" }), resposta(200, { projects: [] })],
    async () => {
      await loadProjects()
    },
  )

  // sem repetir, o painel ficaria preso no token velho e a lista vazia
  assert.deepEqual(enviados, ["token-velho", "token-velho"])
})

test("um token que não vale não vira laço infinito", async () => {
  let chamadas = 0
  await comFakes(
    "token-velho",
    ["token-velho"],
    [resposta(401, { error: "token inválido" }), resposta(401, { error: "token inválido" })],
    async () => {
      chamadas++
      await assert.rejects(loadProjects(), /token inválido/)
      chamadas++
    },
  )

  // uma tentativa original e uma repetição: nada mais
  assert.equal(chamadas, 2)
})
