#!/usr/bin/env node
/**
 * Popula node_modules a partir de cópias locais dos pacotes.
 *
 * O ambiente de desenvolvimento não tem acesso ao registry npm, então este
 * script copia os pacotes de fontes disponíveis na máquina. Com rede, o
 * `pnpm install` normal funciona e este script torna-se dispensável.
 */
import { existsSync, mkdirSync, cpSync, symlinkSync, rmSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dest = join(root, "node_modules")

/** fontes de pacotes disponíveis localmente */
const SOURCES = [
  "/home/vinicius/.local/share/Trash/files/node_modules",
  "/home/vinicius/.config/opencode/node_modules",
  "/home/vinicius/node_modules",
]

/** pacotes que o projeto usa de verdade */
const PACKAGES = [
  "zod",
  "ws",
  "typescript",
  "esbuild",
  "tsx",
  "playwright",
  "playwright-core",
  "@types/node",
  "@types/ws",
  "@typescript/typescript-linux-x64",
  "@esbuild/linux-x64",
]

const SCOPED = ["@types/node", "@types/ws"]

function findPackage(name) {
  for (const source of SOURCES) {
    const candidate = join(source, name)
    if (existsSync(join(candidate, "package.json"))) return candidate
  }
  return null
}

function copyPackage(name) {
  const from = findPackage(name)
  if (!from) {
    console.error(`  ✗ ${name}: não encontrado em nenhuma fonte local`)
    return false
  }
  const to = join(dest, name)
  mkdirSync(dirname(to), { recursive: true })
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true, dereference: true })
  const { version } = JSON.parse(readFileSync(join(to, "package.json"), "utf8"))
  console.log(`  ✓ ${name}@${version}`)
  return true
}

console.log("vendorizando pacotes offline")
mkdirSync(dest, { recursive: true })

let ok = true
for (const name of PACKAGES) {
  if (!copyPackage(name)) ok = false
}

// binários
const binDir = join(dest, ".bin")
mkdirSync(binDir, { recursive: true })
const BINS = {
  tsc: "typescript/bin/tsc",
  tsx: "tsx/dist/cli.mjs",
  esbuild: "esbuild/bin/esbuild",
}
for (const [bin, rel] of Object.entries(BINS)) {
  const target = join(dest, rel)
  if (!existsSync(target)) continue
  const link = join(binDir, bin)
  rmSync(link, { force: true })
  symlinkSync(join("..", rel), link)
}

// links internos dos pacotes do workspace
for (const pkg of ["core", "server", "cli"]) {
  const link = join(dest, "@griver", pkg)
  mkdirSync(dirname(link), { recursive: true })
  rmSync(link, { recursive: true, force: true })
  symlinkSync(join("..", "..", "packages", pkg), link)
}

console.log(ok ? "\npronto" : "\ncom pendências (veja acima)")
process.exit(ok ? 0 : 1)
