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
  const dataDir = mkdtempSync(join(tmpdir(), "griver-rec-"))
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
 * para conferir quem recebeu os passos da gravação.
 */
async function connectExtension(base: string): Promise<{
  socket: WebSocket
  received: ServerMessage[]
  send: (message: unknown) => void
}> {
  const url = `${base.replace(/^http/, "ws")}/ws`
  const socket = new WebSocket(url)
  const received: ServerMessage[] = []

  await new Promise<void>((resolve, reject) => {
    socket.on("open", resolve)
    socket.on("error", reject)
  })

  socket.on("message", (raw) => {
    received.push(decode<ServerMessage>(raw.toString()))
  })

  socket.send(JSON.stringify({ type: "hello", token: TOKEN, clientVersion: "0.1.0" }))
  // o `hello.ok` confirma que o token foi aceito — sem ele o teste mediria
  // uma corrida
  const autenticada = await waitFor(() => received.some((message) => message.type === "hello.ok"))
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

test("a gravação fica com a extensão que começou", async () => {
  await withServer(async (base) => {
    const dona = await connectExtension(base)
    const outra = await connectExtension(base)

    try {
      dona.send({ type: "record.start", projectId: "p1" })
      await waitFor(() => dona.received.some((message) => message.type === "record.state"))

      // a outra extensão manda um evento no meio: ele não é desta gravação
      dona.send({
        type: "record.event",
        event: { kind: "click", selectors: ["#a"], ts: 1 },
      })
      outra.send({
        type: "record.event",
        event: { kind: "click", selectors: ["#b"], ts: 2 },
      })

      await waitFor(() => dona.received.some((message) => message.type === "record.step"))
      dona.send({ type: "record.stop" })
      await waitFor(() => dona.received.some((message) => message.type === "record.finished"))

      // a dona recebe só o próprio passo
      const passos = dona.received.filter((message) => message.type === "record.step")
      assert.equal(passos.length, 1, "a dona deve receber só o próprio passo")

      const finalizada = dona.received.find(
        (message) => message.type === "record.finished",
      ) as { recipe?: { steps: { target?: { selectors?: string[] } }[] } }
      assert.equal(finalizada.recipe?.steps.length, 1, "a receita tem só o passo da dona")
      assert.equal(
        finalizada.recipe?.steps[0]?.target?.selectors?.[0],
        "#a",
        "o passo é o da dona, não o da outra extensão",
      )

      // a outra extensão não recebe passo nenhum nem a receita
      await new Promise((resolve) => setTimeout(resolve, 300))
      const indevida = outra.received.filter(
        (message) => message.type === "record.step" || message.type === "record.finished",
      )
      assert.equal(indevida.length, 0, "a outra extensão não deve receber passos nem a receita")
    } finally {
      dona.socket.terminate()
      outra.socket.terminate()
    }
  })
})

test("uma gravação começada por HTTP fica com quem mandou os eventos", async () => {
  await withServer(async (base) => {
    const extensao = await connectExtension(base)

    try {
      const response = await fetch(`${base}/api/recording/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Griver-Token": TOKEN },
        body: JSON.stringify({ projectId: "p1" }),
      })
      assert.equal(response.status, 200)

      extensao.send({
        type: "record.event",
        event: { kind: "click", selectors: ["#a"], ts: 1 },
      })
      await waitFor(() => extensao.received.some((message) => message.type === "record.step"))

      extensao.send({ type: "record.stop" })
      await waitFor(() => extensao.received.some((message) => message.type === "record.finished"))

      const finalizada = extensao.received.find(
        (message) => message.type === "record.finished",
      ) as { recipe?: { steps: unknown[] } }
      assert.equal(finalizada.recipe?.steps.length, 1, "a receita volta para quem gravou")
    } finally {
      extensao.socket.terminate()
    }
  })
})
