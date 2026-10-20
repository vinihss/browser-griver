import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WebSocket } from "ws"
import { startServer } from "../src/index.js"
import { decode, type ServerMessage } from "@griver/core"

const TOKEN = "token-de-teste"

async function withServer(fn: (base: string) => Promise<void>) {
  const dataDir = mkdtempSync(join(tmpdir(), "griver-run-"))
  const server = await startServer({ dataDir, port: 0, token: TOKEN })
  try {
    await fn(server.url)
  } finally {
    await server.close()
  }
}

/**
 * Abre uma conexão de extensão e devolve as mensagens recebidas.
 *
 * A lista cresce conforme as mensagens chegam — o teste inspeciona isso
 * para conferir quem recebeu o comando de execução.
 */
async function connectExtension(
  base: string,
  opcoes: { responder?: boolean } = {},
): Promise<{
  socket: WebSocket
  received: ServerMessage[]
  send: (message: unknown) => void
}> {
  const url = `${base.replace(/^http/, "ws")}/ws`
  const socket = new WebSocket(url)
  const received: ServerMessage[] = []
  const responder = opcoes.responder ?? true

  await new Promise<void>((resolve, reject) => {
    socket.on("open", resolve)
    socket.on("error", reject)
  })

  socket.on("message", (raw) => {
    const message = decode<ServerMessage>(raw.toString())
    received.push(message)

    // responde à execução como a extensão real faria: sem isso o
    // servidor segura o resultado por 120s e o processo do teste não
    // consegue encerrar
    if (message.type === "run.request" && responder) {
      socket.send(
        JSON.stringify({
          type: "run.result",
          runId: message.runId,
          status: "ok",
          events: [],
        }),
      )
    }
  })

  socket.send(JSON.stringify({ type: "hello", token: TOKEN, clientVersion: "0.1.0" }))
  // o `hello.ok` confirma que o token foi aceito e a extensão está
  // autenticada — sem ele o teste mediria uma corrida
  const autenticada = await waitFor(() =>
    received.some((message) => message.type === "hello.ok"),
  )
  assert.equal(autenticada, true, "a extensão deve ser autenticada pelo servidor")

  return {
    socket,
    received,
    send: (message: unknown) => socket.send(JSON.stringify(message)),
  }
}

/** Espera a condição ficar verdadeira, sem travar o teste se nunca ficar. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

/** Cria um projeto e uma receita de um passo. */
async function createRecipe(base: string): Promise<string> {
  const headers = { "Content-Type": "application/json", "X-Griver-Token": TOKEN }

  const projectResponse = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Projeto do teste" }),
  })
  const project = (await projectResponse.json()) as { project: { id: string } }

  const recipeResponse = await fetch(`${base}/api/recipes`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      projectId: project.project.id,
      name: "Receita do teste",
      target: "browser",
      recipe: { version: 1, steps: [{ id: "s1", type: "navigate", url: "https://exemplo.com" }] },
    }),
  })
  const recipe = (await recipeResponse.json()) as { recipe: { id: string } }
  return recipe.recipe.id
}

test("a execução na aba vai só para a extensão que pediu", async () => {
  await withServer(async (base) => {
    const recipeId = await createRecipe(base)

    const primeira = await connectExtension(base)
    const segunda = await connectExtension(base)

    try {
      // a primeira extensão pede a execução
      primeira.send({ type: "run.start", recipeId, driver: "tab" })

      const recebeu = await waitFor(() =>
        primeira.received.some((message) => message.type === "run.request"),
      )
      assert.equal(recebeu, true, "a extensão que pediu deve receber o comando")

      // a segunda não pode receber: se recebesse, executaria na aba dela
      await new Promise((resolve) => setTimeout(resolve, 300))
      const indevida = segunda.received.filter((message) => message.type === "run.request")
      assert.equal(indevida.length, 0, "a outra extensão não deve receber o comando")
    } finally {
      primeira.socket.terminate()
      segunda.socket.terminate()
    }
  })
})

test("uma execução por vez na aba: a segunda espera a primeira terminar", async () => {
  await withServer(async (base) => {
    const recipeId = await createRecipe(base)

    // a extensão não responde sozinha: o teste decide quando cada execução
    // acaba, senão as duas se atropelariam e a fila não teria o que provar
    const extensao = await connectExtension(base, { responder: false })

    const pedidos = () => extensao.received.filter((message) => message.type === "run.request")

    try {
      extensao.send({ type: "run.start", recipeId, driver: "tab" })
      extensao.send({ type: "run.start", recipeId, driver: "tab" })

      const chegou = await waitFor(() => pedidos().length >= 1)
      assert.equal(chegou, true, "a primeira execução deve chegar à extensão")

      // a segunda espera: duas execuções na mesma aba se atropelam — o
      // navigate de uma apaga o DOM que a outra está lendo
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(pedidos().length, 1, "a segunda execução não pode entrar junto com a primeira")

      // a primeira termina: a segunda entra
      extensao.send({ type: "run.result", runId: pedidos()[0]!.runId, status: "ok", events: [] })

      const liberou = await waitFor(() => pedidos().length >= 2)
      assert.equal(liberou, true, "a segunda execução deve entrar depois que a primeira termina")
      assert.notEqual(pedidos()[0]!.runId, pedidos()[1]!.runId, "são execuções diferentes")

      // sem isso o servidor segura o resultado por 120s e o teste não acaba
      extensao.send({ type: "run.result", runId: pedidos()[1]!.runId, status: "ok", events: [] })
    } finally {
      extensao.socket.terminate()
    }
  })
})

test("a execução via HTTP vai para uma única extensão", async () => {
  await withServer(async (base) => {
    const recipeId = await createRecipe(base)

    const primeira = await connectExtension(base)
    const segunda = await connectExtension(base)

    try {
      const response = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Griver-Token": TOKEN },
        body: JSON.stringify({ recipeId, driver: "tab" }),
      })
      assert.equal(response.status, 200)

      // exatamente uma das duas recebe o comando
      const receberam = await waitFor(() => {
        const total =
          primeira.received.filter((message) => message.type === "run.request").length +
          segunda.received.filter((message) => message.type === "run.request").length
        return total > 0
      })
      assert.equal(receberam, true, "alguma extensão deve receber o comando")

      await new Promise((resolve) => setTimeout(resolve, 300))
      const total =
        primeira.received.filter((message) => message.type === "run.request").length +
        segunda.received.filter((message) => message.type === "run.request").length
      assert.equal(total, 1, "apenas uma extensão pode executar na aba")
    } finally {
      primeira.socket.terminate()
      segunda.socket.terminate()
    }
  })
})

test("duas execuções na mesma aba não se atropelam", async () => {
  await withServer(async (base) => {
    const recipeId = await createRecipe(base)

    // uma extensão só: as duas execuções caem na mesma aba
    // ela não responde nada, para a primeira execução ficar em andamento
    const extensao = await connectExtension(base, { responder: false })

    const pedidos = () =>
      extensao.received.filter((message) => message.type === "run.request")

    try {
      for (let i = 0; i < 2; i++) {
        const response = await fetch(`${base}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Griver-Token": TOKEN },
          body: JSON.stringify({ recipeId, driver: "tab" }),
        })
        assert.equal(response.status, 200)
      }

      // a primeira execução chegou…
      const primeiraChegou = await waitFor(() => pedidos().length >= 1)
      assert.equal(primeiraChegou, true, "a primeira execução deve chegar à extensão")

      // …e a segunda espera: a aba só aguenta uma receita por vez
      await new Promise((resolve) => setTimeout(resolve, 400))
      assert.equal(
        pedidos().length,
        1,
        "a segunda execução não pode entrar enquanto a primeira não termina",
      )

      // a primeira termina: a segunda entra em seguida
      const primeira = pedidos()[0] as { runId: string }
      extensao.send({
        type: "run.result",
        runId: primeira.runId,
        status: "ok",
        events: [],
      })

      const segundaChegou = await waitFor(() => pedidos().length >= 2, 5000)
      assert.equal(segundaChegou, true, "a segunda execução entra depois da primeira")
      assert.notEqual(pedidos()[1]?.runId, primeira.runId, "são execuções diferentes")

      // a segunda também termina: sem isso o servidor segura o resultado
      // por 120s e o processo do teste não consegue encerrar
      const segunda = pedidos()[1] as { runId: string }
      extensao.send({
        type: "run.result",
        runId: segunda.runId,
        status: "ok",
        events: [],
      })
    } finally {
      extensao.socket.terminate()
    }
  })
})
