import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GriverOps } from "../src/ops.js"
import { GriverRestClient } from "../src/rest.js"
import { startServer } from "../src/index.js"

/**
 * A camada de operações é o que o MCP e a linha de comando usam.
 *
 * Estes testes olham duas coisas: como o cliente resolve o token (e se
 * repara quando o servidor troca de token) e se cada operação chega no
 * caminho certo da API.
 */

/** Troca o fetch global por um que responde o que o teste quiser. */
async function comFetch(
  responder: (url: string, init: RequestInit | undefined, chamada: number) => Response,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch
  let chamadas = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    chamadas += 1
    return responder(String(input), init, chamadas)
  }) as typeof globalThis.fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = original
  }
}

test("o token do ambiente vale", async () => {
  const anterior = process.env.GRIVER_TOKEN
  process.env.GRIVER_TOKEN = "token-do-ambiente"
  try {
    const client = new GriverRestClient()
    assert.equal(await client.token(), "token-do-ambiente")
  } finally {
    if (anterior === undefined) delete process.env.GRIVER_TOKEN
    else process.env.GRIVER_TOKEN = anterior
  }
})

test("o GRIVER_TOKEN pode ser o caminho do arquivo que guarda o token", async () => {
  const pasta = mkdtempSync(join(tmpdir(), "griver-token-"))
  const arquivo = join(pasta, "segredo")
  writeFileSync(arquivo, "token-do-arquivo", "utf8")

  const anterior = process.env.GRIVER_TOKEN
  process.env.GRIVER_TOKEN = arquivo
  try {
    const client = new GriverRestClient()
    assert.equal(await client.token(), "token-do-arquivo")
  } finally {
    if (anterior === undefined) delete process.env.GRIVER_TOKEN
    else process.env.GRIVER_TOKEN = anterior
  }
})

test("o token vem do arquivo da pasta de dados", async () => {
  const pasta = mkdtempSync(join(tmpdir(), "griver-token-"))
  writeFileSync(join(pasta, "token"), "token-da-pasta", "utf8")

  const anterior = process.env.GRIVER_TOKEN
  delete process.env.GRIVER_TOKEN
  try {
    const client = new GriverRestClient({ dataDir: pasta })
    assert.equal(await client.token(), "token-da-pasta")
  } finally {
    if (anterior !== undefined) process.env.GRIVER_TOKEN = anterior
  }
})

test("um 401 relê o token e tenta de novo", async () => {
  const pasta = mkdtempSync(join(tmpdir(), "griver-token-"))
  const arquivo = join(pasta, "token")
  writeFileSync(arquivo, "token-velho", "utf8")

  const anterior = process.env.GRIVER_TOKEN
  delete process.env.GRIVER_TOKEN
  try {
    await comFetch(
      (_url, _init, chamada) => {
        if (chamada === 1) {
          // o servidor reiniciou e gravou o token novo no arquivo
          writeFileSync(arquivo, "token-novo", "utf8")
          return new Response(JSON.stringify({ error: "token inválido" }), { status: 401 })
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
      async () => {
        const client = new GriverRestClient({ dataDir: pasta })
        const resposta = await client.api<{ ok: boolean }>("/api/health")
        assert.equal(resposta.ok, true)
      },
    )
  } finally {
    if (anterior !== undefined) process.env.GRIVER_TOKEN = anterior
  }
})

test("um 401 que não se resolve vira erro legível", async () => {
  await comFetch(
    () => new Response(JSON.stringify({ error: "token inválido" }), { status: 401 }),
    async () => {
      const client = new GriverRestClient({ token: "fixo" })
      await assert.rejects(
        async () => await client.api("/api/health"),
        /Token inválido ao falar com o Griver/,
      )
    },
  )
})

test("cada operação bate no caminho e no método certos", async () => {
  const chamadas: { url: string; method: string; body: unknown }[] = []
  await comFetch(
    (url, init) => {
      chamadas.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    },
    async () => {
      const ops = new GriverOps({ token: "qualquer" })
      await ops.listProjects()
      await ops.createProject({ name: "X" })
      await ops.updateProject("p1", { name: "Y" })
      await ops.deleteProject("p1")
      await ops.listRecipes("proj")
      await ops.getRecipe("r1")
      await ops.createRecipe({ name: "R", projectId: "p1" })
      await ops.updateRecipe("r1", { name: "R2" })
      await ops.deleteRecipe("r1")
      await ops.listRevisions("r1")
      await ops.restoreRevision("r1", "rev1")
      await ops.listRuns()
      await ops.cancelRun("run1")
      await ops.listSchedules()
      await ops.deleteSchedule("s1")
      await ops.recordingState()
      await ops.recordStart()
      await ops.pageContext()
      await ops.pageClick({ selectors: ["#a"] })
      await ops.pageFill({ selectors: ["#a"] }, "texto")
    },
  )

  const resumo = chamadas.map((c) => `${c.method} ${c.url.replace("http://127.0.0.1:7331", "")}`)
  assert.deepEqual(resumo, [
    "GET /api/projects",
    "POST /api/projects",
    "PATCH /api/projects/p1",
    "DELETE /api/projects/p1",
    "GET /api/recipes?projectId=proj",
    "GET /api/recipes/r1",
    "POST /api/recipes",
    "PATCH /api/recipes/r1",
    "DELETE /api/recipes/r1",
    "GET /api/recipes/r1/revisions",
    "POST /api/recipes/r1/revisions/rev1/restore",
    "GET /api/runs",
    "POST /api/runs/run1/cancel",
    "GET /api/schedules",
    "DELETE /api/schedules/s1",
    "GET /api/recording",
    "POST /api/recording/start",
    "POST /api/page/context",
    "POST /api/page/click",
    "POST /api/page/fill",
  ])

  const clique = chamadas.find((c) => c.url.endsWith("/api/page/click"))
  assert.deepEqual(clique?.body, { target: { selectors: ["#a"] } })
  const preenchimento = chamadas.find((c) => c.url.endsWith("/api/page/fill"))
  assert.deepEqual(preenchimento?.body, { target: { selectors: ["#a"] }, value: "texto" })
})

test("as operações de passos mudam a receita como foi pedido", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "griver-ops-"))
  const server = await startServer({ dataDir, port: 0, token: "token-de-teste" })
  try {
    const ops = new GriverOps({ baseUrl: server.url, token: server.config.token })
    const projetos = await ops.listProjects()
    const projectId =
      projetos.projects[0]?.id ?? (await ops.createProject({ name: "P" })).project.id

    const criada = await ops.createRecipe({
      projectId,
      name: "Passos",
      recipe: { version: 1, steps: [{ id: "s1", type: "navigate", url: "https://a.com" }] },
    })
    const id = criada.recipe.id

    // add no fim
    await ops.patchRecipeSteps(id, [{ op: "add", step: { type: "click", target: { selectors: ["#b"] } } }])
    let corpo = (await ops.getRecipe(id)).body
    assert.equal(corpo.steps.length, 2)

    // add no começo
    await ops.patchRecipeSteps(id, [
      { op: "add", index: 0, step: { type: "click", target: { selectors: ["#primeiro"] } } },
    ])
    corpo = (await ops.getRecipe(id)).body
    assert.equal(corpo.steps.length, 3)
    assert.deepEqual(
      (corpo.steps[0] as { target: { selectors: string[] } }).target.selectors,
      ["#primeiro"],
    )

    // update
    await ops.patchRecipeSteps(id, [{ op: "update", index: 0, step: { type: "press", key: "Enter" } }])
    corpo = (await ops.getRecipe(id)).body
    assert.equal(corpo.steps[0]?.type, "press")

    // move
    await ops.patchRecipeSteps(id, [{ op: "move", index: 0, to: 2 }])
    corpo = (await ops.getRecipe(id)).body
    assert.equal(corpo.steps[2]?.type, "press")

    // remove
    await ops.patchRecipeSteps(id, [{ op: "remove", index: 0 }])
    corpo = (await ops.getRecipe(id)).body
    assert.equal(corpo.steps.length, 2)

    // índice fora do lugar é erro, não passo perdido
    await assert.rejects(
      async () => await ops.patchRecipeSteps(id, [{ op: "remove", index: 99 }]),
      /índice inválido/,
    )
  } finally {
    await server.close()
  }
})
