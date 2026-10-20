import { existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { OpenCodeClient } from "@griver/server/opencode/client"
import { resolveDataDir, opencodeConfigDir } from "../shared.js"

interface Check {
  name: string
  ok: boolean
  detail: string
}

export async function commandDoctor(argv: string[]): Promise<number> {
  const dataDir = resolveDataDir(
    argv.find((arg) => arg.startsWith("--data-dir="))?.split("=")[1],
  )
  const checks: Check[] = []

  // Node
  const [major, minor] = process.versions.node.split(".").map(Number)
  checks.push({
    name: "Node.js",
    ok: (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 5),
    detail: process.versions.node,
  })

  // SQLite embutido
  try {
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(":memory:")
    db.exec("create table t(a)")
    db.close()
    checks.push({ name: "node:sqlite", ok: true, detail: "disponível" })
  } catch (error) {
    checks.push({
      name: "node:sqlite",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    })
  }

  // Playwright
  try {
    const pw = await import("playwright")
    const version = (pw as unknown as { chromium?: unknown }).chromium ? "instalado" : "incompleto"
    const browsers = join(homedir(), ".cache", "ms-playwright")
    const hasBrowsers = existsSync(browsers)
    checks.push({
      name: "Playwright",
      ok: true,
      detail: hasBrowsers ? `${version} (browsers em cache)` : `${version} (sem browsers em cache)`,
    })
  } catch {
    checks.push({ name: "Playwright", ok: false, detail: "não instalado" })
  }

  // Chrome do sistema
  for (const binary of ["/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(binary)) {
      checks.push({ name: "Chrome", ok: true, detail: binary })
      break
    }
  }
  if (!checks.some((check) => check.name === "Chrome")) {
    checks.push({ name: "Chrome", ok: false, detail: "nenhum binário encontrado" })
  }

  // Firecrawl
  checks.push({
    name: "Firecrawl",
    ok: Boolean(process.env.FIRECRAWL_API_KEY),
    detail: process.env.FIRECRAWL_API_KEY ? "chave configurada" : "FIRECRAWL_API_KEY ausente",
  })

  // OpenCode
  const client = new OpenCodeClient(opencodeConfigDir())
  const endpoint = await client.discover()
  if (endpoint) {
    try {
      const info = await client.info()
      checks.push({ name: "OpenCode", ok: true, detail: `${endpoint} (v${info.version})` })
    } catch (error) {
      checks.push({
        name: "OpenCode",
        ok: false,
        detail: `endpoint ${endpoint} sem auth: ${error instanceof Error ? error.message : error}`,
      })
    }
  } else {
    checks.push({ name: "OpenCode", ok: false, detail: "serviço local não está rodando" })
  }

  // token do Griver
  const tokenPath = join(dataDir, "token")
  checks.push({
    name: "Token Griver",
    ok: existsSync(tokenPath),
    detail: existsSync(tokenPath) ? tokenPath : "será criado no primeiro `griver serve`",
  })

  console.log("")
  for (const check of checks) {
    console.log(`  ${check.ok ? "✓" : "✗"} ${check.name.padEnd(14)} ${check.detail}`)
  }
  console.log("")

  const failed = checks.filter((check) => !check.ok)
  if (failed.length) {
    console.log(`${failed.length} verificação(ões) falharam.`)
  }
  return failed.length ? 1 : 0
}
