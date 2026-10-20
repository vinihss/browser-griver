import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startServer } from "../src/index.js"
import { atender, catalogo, type RequisicaoMcp, type RespostaMcp } from "../src/mcp/server.js"

/**
 * O servidor MCP falando com um servidor do Griver de verdade.
 *
 * As ferramentas vão pela REST do servidor local — o mesmo caminho que o
 * assistente usa quando conversa pela extensão.
 */
async function comServidor(fn: (chamar: (requisicao: RequisicaoMcp) => Promise<RespostaMcp | undefined>) => Promise<void>) {
  const dataDir = mkdtempSync(join(tmpdir(), "griver-mcp-"))
  const server = await startServer({ dataDir, port: 0, token: "token-de-teste" })
  process.env.GRIVER_SERVER_URL = server.url
  process.env.GRIVER_TOKEN = server.config.token
  try {
    await fn(async (requisicao) => await atender(requisicao))
  } finally {
    await server.close()
  }
}

test("o initialize se apresenta como o servidor do Griver", async () => {
  const resposta = await atender({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  })
  assert.ok(resposta?.result)
  const resultado = resposta.result as {
    protocolVersion: string
    capabilities: { tools: unknown }
    serverInfo: { name: string }
  }
  assert.equal(resultado.serverInfo.name, "griver")
  assert.equal(resultado.protocolVersion, "2025-06-18")
  assert.ok(resultado.capabilities.tools)
})

test("a notificação não ganha resposta", async () => {
  const resposta = await atender({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  })
  assert.equal(resposta, undefined)
})

test("o catálogo traz as ferramentas do Griver", () => {
  const nomes = catalogo().map((ferramenta) => ferramenta.name)
  for (const esperado of [
    "recipe_list",
    "recipe_get",
    "recipe_patch",
    "recipe_validate",
    "page_context",
    "page_click",
    "page_fill",
    "run",
  ]) {
    assert.ok(nomes.includes(esperado), `falta a ferramenta ${esperado}`)
  }
})

test("a ferramenta de listar enxerga a receita criada", async () => {
  await comServidor(async (chamar) => {
    const base = process.env.GRIVER_SERVER_URL!
    const token = process.env.GRIVER_TOKEN!
    const projeto = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Griver-Token": token },
      body: JSON.stringify({ name: "Projetos do teste" }),
    })
    const { project } = (await projeto.json()) as { project: { id: string } }

    const receita = await fetch(`${base}/api/recipes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Griver-Token": token },
      body: JSON.stringify({
        projectId: project.id,
        name: "Receita do MCP",
        target: "browser",
        recipe: { version: 1, steps: [{ id: "s1", type: "navigate", url: "https://exemplo.com" }] },
      }),
    })
    assert.equal(receita.status, 200)

    const resposta = await chamar({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "recipe_list", arguments: {} },
    })
    assert.ok(resposta?.result)
    const conteudo = (resposta.result as { content: { text: string }[] }).content
    assert.match(conteudo[0]!.text, /Receita do MCP/)
  })
})

test("a ferramenta que falha devolve o motivo, não derruba a chamada", async () => {
  await comServidor(async (chamar) => {
    const resposta = await chamar({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "recipe_get", arguments: { recipeId: "não-existe" } },
    })
    assert.ok(resposta?.result)
    const resultado = resposta.result as { content: { text: string }[]; isError?: boolean }
    assert.equal(resultado.isError, true)
    assert.ok(resultado.content[0]!.text.length > 0)
  })
})

test("ferramenta desconhecida é erro de protocolo", async () => {
  const resposta = await atender({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "nada_disso", arguments: {} },
  })
  assert.ok(resposta?.error)
  assert.equal(resposta.error.code, -32602)
})

/**
 * A configuração do OpenCode e o catálogo das ferramentas não podem
 * divergir: um nome trocado no código e não na config deixa o clique sem
 * aprovação — ou tira a aprovação de um clique que devia ter.
 */
test("a config do OpenCode bate com o catálogo de ferramentas", async () => {
  const raiz = join(import.meta.dirname, "..", "..", "..")
  const config = JSON.parse(readFileSync(join(raiz, "opencode.json"), "utf8")) as {
    mcp?: { servers?: Record<string, { type: string; command: string[] }> }
    agents?: Record<string, { permissions?: { action: string; effect: string }[] }>
  }

  const servidor = config.mcp?.servers?.griver
  assert.ok(servidor, "o opencode.json precisa registrar o servidor MCP griver")
  assert.equal(servidor.type, "local")
  assert.ok(
    servidor.command.some((parte) => parte.includes("mcp/main.js")),
    `o comando precisa apontar para o entrypoint do MCP: ${servidor.command.join(" ")}`,
  )

  const nomes = new Set(catalogo().map((ferramenta) => ferramenta.name))
  const comPrefixo = (acao: string) => acao.startsWith("griver_") && acao.slice("griver_".length)

  for (const [nome, agente] of Object.entries(config.agents ?? {})) {
    for (const permissao of agente.permissions ?? []) {
      if (permissao.effect !== "ask") continue
      const ferramenta = comPrefixo(permissao.action)
      assert.ok(
        ferramenta && nomes.has(ferramenta),
        `a permissão "${permissao.action}" do agente ${nome} não casa com nenhuma ferramenta do catálogo`,
      )
    }
  }
})
