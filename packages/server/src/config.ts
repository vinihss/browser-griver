import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"

export interface ServerConfig {
  /** porta HTTP/WS do servidor local */
  port: number
  /** endereço de escuta — loopback por padrão */
  host: string
  /** pasta de dados (banco, artefatos, capturas) */
  dataDir: string
  /** caminho do banco SQLite */
  dbPath: string
  /** pasta de capturas de tela e artefatos de execução */
  artifactsDir: string
  /** token compartilhado com a extensão */
  token: string
  /** diretório de dados do OpenCode (para achar service.json) */
  opencodeConfigDir: string
  /** URL base da API do Firecrawl */
  firecrawlApiBase: string
  firecrawlApiKey?: string
}

function findOpencodeConfigDir(): string {
  const candidates = [
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode"),
    join(homedir(), ".config", "opencode"),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]!
}

function loadOrCreateToken(dataDir: string): string {
  const tokenPath = join(dataDir, "token")
  if (existsSync(tokenPath)) {
    const value = readFileSync(tokenPath, "utf8").trim()
    if (value) return value
  }
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  const token = Buffer.from(bytes).toString("base64url")
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 })
  return token
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dataDir = resolve(overrides.dataDir ?? process.env.GRIVER_DATA_DIR ?? join(process.cwd(), "data"))
  mkdirSync(dataDir, { recursive: true })
  const artifactsDir = join(dataDir, "artifacts")
  mkdirSync(artifactsDir, { recursive: true })

  return {
    port: overrides.port ?? Number(process.env.GRIVER_PORT ?? 7331),
    host: overrides.host ?? process.env.GRIVER_HOST ?? "127.0.0.1",
    dataDir,
    dbPath: join(dataDir, "griver.db"),
    artifactsDir,
    token: overrides.token ?? loadOrCreateToken(dataDir),
    opencodeConfigDir: findOpencodeConfigDir(),
    firecrawlApiBase: overrides.firecrawlApiBase ?? process.env.FIRECRAWL_API_BASE ?? "https://api.firecrawl.dev/v2",
    firecrawlApiKey: overrides.firecrawlApiKey ?? process.env.FIRECRAWL_API_KEY,
  }
}
