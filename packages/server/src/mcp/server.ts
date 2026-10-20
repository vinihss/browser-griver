/**
 * Servidor MCP do Griver.
 *
 * O assistente conversa com o Griver por MCP — o mesmo protocolo que
 * qualquer outro servidor de ferramentas usa. As mensagens são JSON-RPC
 * 2.0 separadas por linha: é assim que o transporte stdio funciona.
 *
 * O nome do servidor (`griver`) é o prefixo das ferramentas: `recipe_patch`
 * vira `griver_recipe_patch`.
 */
import { createInterface } from "node:readline"
import { ferramentas, type Ferramenta } from "./tools.js"

/** Versões do protocolo que este servidor entende. */
const VERSOES = ["2025-11-25", "2025-06-18", "2024-11-05"]
const VERSAO_PADRAO = "2025-06-18"

export interface RequisicaoMcp {
  jsonrpc: "2.0"
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

export interface RespostaMcp {
  jsonrpc: "2.0"
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

/** O catálogo que o cliente recebe em `tools/list`. */
export function catalogo(): { name: string; description: string; inputSchema: unknown }[] {
  return ferramentas.map((ferramenta: Ferramenta) => ({
    name: ferramenta.name,
    description: ferramenta.description,
    inputSchema: ferramenta.inputSchema,
  }))
}

/**
 * Atende uma requisição.
 *
 * Devolve `undefined` para as notificações — elas não têm resposta, e
 * responder a uma notificação é erro de protocolo.
 */
export async function atender(requisicao: RequisicaoMcp): Promise<RespostaMcp | undefined> {
  const id = requisicao.id ?? null
  const responder = (resultado: unknown): RespostaMcp => ({ jsonrpc: "2.0", id, result: resultado })
  const falhar = (code: number, message: string): RespostaMcp => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  })

  switch (requisicao.method) {
    case "initialize": {
      const pedido = requisicao.params?.protocolVersion
      const versao =
        typeof pedido === "string" && VERSOES.includes(pedido) ? pedido : VERSAO_PADRAO
      return responder({
        protocolVersion: versao,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "griver", version: "0.1.0" },
      })
    }

    case "ping":
      return responder({})

    case "tools/list":
      return responder({ tools: catalogo() })

    case "tools/call": {
      const nome = requisicao.params?.name
      const argumentos = (requisicao.params?.arguments ?? {}) as Record<string, unknown>
      if (typeof nome !== "string") {
        return falhar(-32602, "tools/call precisa do nome da ferramenta")
      }
      const ferramenta = ferramentas.find((candidata) => candidata.name === nome)
      if (!ferramenta) {
        return falhar(-32602, `ferramenta desconhecida: ${nome}`)
      }
      try {
        const texto = await ferramenta.executar(argumentos)
        return responder({ content: [{ type: "text", text: texto }] })
      } catch (error) {
        // a falha da ferramenta não é falha do protocolo: o conteúdo volta
        // como texto e o modelo consegue ler o que deu errado
        const mensagem = error instanceof Error ? error.message : String(error)
        return responder({
          content: [{ type: "text", text: mensagem }],
          isError: true,
        })
      }
    }

    case "resources/list":
      return responder({ resources: [] })

    case "prompts/list":
      return responder({ prompts: [] })

    default:
      if (requisicao.id === undefined || requisicao.id === null) return undefined
      return falhar(-32601, `método desconhecido: ${requisicao.method}`)
  }
}

/**
 * Escuta o stdin e responde no stdout.
 *
 * O stdout é do protocolo: nada além de JSON-RPC pode sair por ele.
 * Log vai para o stderr, que é onde o cliente olha quando algo dá errado.
 */
export function escutar(entrada: NodeJS.ReadableStream = process.stdin): void {
  // o cliente pode fechar o stdout a qualquer momento: um EPIPE aqui é
  // fim de conversa, não motivo para derrubar o processo com um stack trace
  process.stdout.on("error", () => {})

  const leitor = createInterface({ input: entrada })
  leitor.on("line", (linha) => {
    const texto = linha.trim()
    if (!texto) return

    let requisicao: RequisicaoMcp
    try {
      requisicao = JSON.parse(texto) as RequisicaoMcp
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } })}\n`,
      )
      return
    }

    void atender(requisicao)
      .then((resposta) => {
        if (resposta) process.stdout.write(`${JSON.stringify(resposta)}\n`)
      })
      .catch((error: unknown) => {
        const mensagem = error instanceof Error ? error.message : String(error)
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: requisicao.id ?? null, error: { code: -32603, message: mensagem } })}\n`,
        )
      })
  })
}
