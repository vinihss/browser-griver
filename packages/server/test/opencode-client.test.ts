import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { OpenCodeClient, binarioPadrao } from "../src/opencode/client.js"

test("o binário padrão do OpenCode fica na instalação padrão", () => {
  assert.ok(binarioPadrao().endsWith("/.opencode/bin/opencode"))
})

test("sem o opencode no PATH, o cliente usa a instalação padrão", async () => {
  const anterior = process.env.PATH
  process.env.PATH = "/caminho-que-nao-existe"
  try {
    const client = new OpenCodeClient("/tmp")
    const binario = await client.binario()
    if (existsSync(binarioPadrao())) {
      assert.equal(binario, binarioPadrao())
    } else {
      // sem instalação padrão, o cliente tenta o nome e o erro vem do sistema
      assert.equal(binario, "opencode")
    }
  } finally {
    process.env.PATH = anterior
  }
})

test("com o opencode no PATH, o cliente usa o comando", async () => {
  const client = new OpenCodeClient("/tmp")
  const binario = await client.binario()
  assert.ok(binario === "opencode" || existsSync(binario))
})
