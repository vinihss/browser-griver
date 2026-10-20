import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { startServer, SERVER_VERSION, type GriverServer } from "./index.js"
import type { ServerConfig } from "./config.js"

/**
 * Sobe o servidor e mantém o processo vivo.
 *
 * Usado tanto pelo binário `griver-server` quanto por `griver serve`, para
 * que os dois imprimam a mesma orientação.
 */
export async function runServer(overrides: Partial<ServerConfig> = {}): Promise<GriverServer> {
  const server = await startServer(overrides)

  console.log(`griver ${SERVER_VERSION} ouvindo em ${server.url}`)
  console.log(`  dados:    ${server.config.dataDir}`)
  console.log(`  token:    ${server.config.token}`)
  console.log(`  extensão: ws://${server.config.host}:${server.config.port}/ws`)
  console.log("")
  console.log("Cole o token no painel da extensão para conectar.")
  console.log(`Carregue a extensão de: ${extensionPath()}`)

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} — encerrando...`)
    await server.close()
    process.exit(0)
  }

  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))

  return server
}

/** Caminho da extensão empacotada, relativo a este arquivo. */
export function extensionPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // src/ → dist/ → packages/server/ → packages/ → extension/dist
  return resolve(here, "../../extension/dist")
}
