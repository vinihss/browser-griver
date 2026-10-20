import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startServer } from "../src/index.js"

async function withServer(fn: (base: string, token: string) => Promise<void>) {
  const dataDir = mkdtempSync(join(tmpdir(), "griver-test-"))
  const server = await startServer({ dataDir, port: 0, token: "token-de-teste" })
  try {
    await fn(server.url, server.config.token)
  } finally {
    await server.close()
  }
}

function api(base: string, token: string) {
  return async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Griver-Token": token,
        ...(init.headers ?? {}),
      },
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : undefined }
  }
}

test("health responde sem token", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/health`)
    assert.equal(response.status, 200)
    const body = (await response.json()) as { ok: boolean }
    assert.equal(body.ok, true)
  })
})

test("exige token nas rotas protegidas", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/projects`)
    assert.equal(response.status, 401)
  })
})

test("cria, lista e remove projetos", async () => {
  await withServer(async (base, token) => {
    const call = api(base, token)

    const created = await call("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Meu projeto", description: "teste" }),
    })
    assert.equal(created.status, 200)
    const project = (created.body as { project: { id: string; name: string } }).project
    assert.equal(project.name, "Meu projeto")

    const listed = await call("/api/projects")
    assert.equal((listed.body as { projects: unknown[] }).projects.length, 1)

    const removed = await call(`/api/projects/${project.id}`, { method: "DELETE" })
    assert.equal(removed.status, 200)

    const listedAfter = await call("/api/projects")
    assert.equal((listedAfter.body as { projects: unknown[] }).projects.length, 0)
  })
})

test("cria receita e valida compatibilidade com o alvo", async () => {
  await withServer(async (base, token) => {
    const call = api(base, token)
    const project = (
      (await call("/api/projects", { method: "POST", body: JSON.stringify({ name: "P" }) })).body as {
        project: { id: string }
      }
    ).project

    const recipe = {
      version: 1,
      steps: [
        { id: "a", type: "navigate", url: "https://exemplo.com" },
        { id: "b", type: "click", target: { selectors: ["#a"] } },
      ],
    }

    const ok = await call("/api/recipes", {
      method: "POST",
      body: JSON.stringify({ projectId: project.id, name: "R1", target: "browser", recipe }),
    })
    assert.equal(ok.status, 200)

    // passo exclusivo de browser não pode ser salvo como alvo os
    const invalid = await call("/api/recipes", {
      method: "POST",
      body: JSON.stringify({
        projectId: project.id,
        name: "R2",
        target: "os",
        recipe: {
          version: 1,
          steps: [{ id: "c", type: "select", target: { selectors: ["#s"] }, value: "x" }],
        },
      }),
    })
    assert.equal(invalid.status, 422)
  })
})

test("compila a receita para Playwright", async () => {
  await withServer(async (base, token) => {
    const call = api(base, token)
    const project = (
      (await call("/api/projects", { method: "POST", body: JSON.stringify({ name: "P" }) })).body as {
        project: { id: string }
      }
    ).project
    const created = await call("/api/recipes", {
      method: "POST",
      body: JSON.stringify({
        projectId: project.id,
        name: "R",
        target: "browser",
        recipe: { version: 1, steps: [{ id: "a", type: "navigate", url: "https://x.dev" }] },
      }),
    })
    const recipe = (created.body as { recipe: { id: string } }).recipe

    const compiled = await call(`/api/recipes/${recipe.id}/compile`, {
      method: "POST",
      body: JSON.stringify({ target: "browser" }),
    })
    assert.equal(compiled.status, 200)
    const code = (compiled.body as { code: string }).code
    assert.match(code, /playwright/)
  })
})

test("publica o schema da receita", async () => {
  await withServer(async (base, token) => {
    const call = api(base, token)
    const response = await call("/api/schema/recipe")
    assert.equal(response.status, 200)

    const schema = response.body as {
      $schema: string
      $defs: Record<string, { oneOf: { properties: { type: { const: string } } }[] }>
      properties: { steps: { items: { $ref: string } } }
    }
    assert.match(schema.$schema, /json-schema\.org/)

    // o schema vem do Zod: os passos que ele descreve são os que o
    // servidor aceita
    const referencia = schema.properties.steps.items.$ref.replace("#/$defs/", "")
    const tipos = schema.$defs[referencia]!.oneOf.map((passo) => passo.properties.type.const)
    assert.ok(tipos.includes("navigate"))
    assert.ok(tipos.includes("extract"))
  })
})

test("grava, pausa e descarta uma gravação", async () => {
  await withServer(async (base, token) => {
    const call = api(base, token)
    await call("/api/recording/start", { method: "POST", body: JSON.stringify({ projectId: "p1" }) })
    const state = await call("/api/recording")
    assert.equal((state.body as { status: string }).status, "recording")

    await call("/api/recording/pause", { method: "POST" })
    const paused = await call("/api/recording")
    assert.equal((paused.body as { status: string }).status, "paused")

    await call("/api/recording/discard", { method: "POST" })
    const discarded = await call("/api/recording")
    assert.equal((discarded.body as { status: string }).status, "idle")
  })
})
