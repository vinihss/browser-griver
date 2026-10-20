import { resolve } from "node:path"
import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync, readFileSync } from "node:fs"

export interface GlobalOptions {
  dataDir: string
  json: boolean
  yes: boolean
}

/**
 * Separa as opções globais dos argumentos do comando.
 *
 * A varredura é manual de propósito: `parseArgs` com `strict: false` consumiria
 * flags desconhecidas dos subcomandos (`--file`, `--target`, `--var`...).
 */
export function parseGlobal(argv: string[]): { values: Record<string, unknown>; positionals: string[] } {
  const values: Record<string, unknown> = {}
  const positionals: string[] = []

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === "--json") {
      values.json = true
      continue
    }
    if (arg === "--help" || arg === "-h") {
      values.help = true
      continue
    }
    if (arg === "--yes" || arg === "-y") {
      values.yes = true
      continue
    }
    if (arg === "--data-dir") {
      values.dataDir = argv[++index]
      continue
    }
    if (arg.startsWith("--data-dir=")) {
      values.dataDir = arg.slice("--data-dir=".length)
      continue
    }
    positionals.push(arg)
  }

  return { values, positionals }
}

export function resolveDataDir(explicit?: string): string {
  if (explicit) return resolve(explicit)
  if (process.env.GRIVER_DATA_DIR) return resolve(process.env.GRIVER_DATA_DIR)
  return resolve(process.cwd(), "data")
}

/** Lê o token de acesso do servidor local. */
export function readToken(dataDir: string): string | undefined {
  const path = join(dataDir, "token")
  if (!existsSync(path)) return undefined
  const value = readFileSync(path, "utf8").trim()
  return value || undefined
}

/** Localiza o diretório de configuração do OpenCode. */
export function opencodeConfigDir(): string {
  const candidates = [
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode"),
    join(homedir(), ".config", "opencode"),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]!
}

/** Formata saídarespectando o modo --json. */
export function output(data: unknown, asJson: boolean, render?: () => void): void {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2))
    return
  }
  render?.()
}
