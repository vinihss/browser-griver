import { GriverOps } from "@griver/server/ops"
import { resolveDataDir } from "./shared.js"

/**
 * As operações do Griver, pela linha de comando.
 *
 * É a mesma camada que o MCP usa: uma operação não pode se comportar
 * de um jeito no terminal e de outro no assistente.
 */
export function abrirOps(): GriverOps {
  return new GriverOps({ dataDir: resolveDataDir() })
}

/** O erro do servidor, em português, com a dica do que fazer. */
export function explicarErro(error: unknown): string {
  const mensagem = error instanceof Error ? error.message : String(error)
  if (/fetch failed|ECONNREFUSED|Failed to fetch/i.test(mensagem)) {
    return "o servidor do Griver não respondeu — suba ele com `griver serve`"
  }
  return mensagem
}
