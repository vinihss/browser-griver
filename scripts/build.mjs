#!/usr/bin/env node
/**
 * Compila os pacotes do workspace e empacota a extensão.
 *
 * Usa `tsc -b` para core/server/cli (com project references) e o esbuild
 * para a extensão, que precisa de um bundle por ponto de entrada.
 */
import { execFileSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tsc = join(root, "node_modules", ".bin", "tsc")

function run(command, args, cwd = root) {
  console.log(`\n▸ ${command} ${args.join(" ")}`)
  execFileSync(command, args, { cwd, stdio: "inherit" })
}

run(tsc, ["-b", "packages/core", "packages/server", "packages/cli"])
run(process.execPath, [join(root, "packages", "extension", "build.mjs")])

console.log("\nbuild concluído")
console.log(`  extensão: ${join(root, "packages", "extension", "dist")}`)
console.log(`  cli:      ${join(root, "packages", "cli", "dist", "index.js")}`)
