import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startServer } from "../src/index.js"
import { openDatabase } from "../src/db/index.js"
import { Repository } from "../src/db/repo.js"

test("execuções pendentes de um servidor anterior são encerradas no boot", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "griver-orfas-"))

  // o servidor anterior morreu no meio de uma execução: ela ficou
  // "running" no banco e ninguém mais espera por ela
  const db = openDatabase(join(dataDir, "griver.db"))
  const repo = new Repository(db)
  const orfa = repo.createRun({ recipeName: "Receita", driver: "tab", status: "running" })
  const concluida = repo.createRun({ recipeName: "Receita", driver: "tab", status: "ok" })
  db.close()

  const server = await startServer({ dataDir, port: 0, token: "token-de-teste" })
  try {
    assert.equal(server.orphanedRuns, 1)

    const response = await fetch(`${server.url}/api/runs`, {
      headers: { "X-Griver-Token": "token-de-teste" },
    })
    const body = (await response.json()) as {
      runs: { id: string; status: string; error?: string }[]
    }

    const corrida = body.runs.find((run) => run.id === orfa.id)
    assert.ok(corrida, "a execução órfã continua na lista")
    assert.equal(corrida.status, "error")
    assert.match(corrida.error ?? "", /servidor reiniciou/)

    // execução que já tinha terminado não é mexida
    const pronta = body.runs.find((run) => run.id === concluida.id)
    assert.equal(pronta?.status, "ok")
  } finally {
    await server.close()
  }
})

test("um servidor novo não encerra execuções que ele mesmo criou", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "griver-orfas-"))
  const server = await startServer({ dataDir, port: 0, token: "token-de-teste" })
  try {
    assert.equal(server.orphanedRuns, 0)
  } finally {
    await server.close()
  }
})
