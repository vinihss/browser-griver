#!/usr/bin/env node
/**
 * Empacota a extensão Chrome.
 *
 * O content script é gerado como IIFE (scripts de conteúdo não aceitam ESM),
 * enquanto o service worker e o painel usam módulos.
 */
import { build, context } from "esbuild"
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(fileURLToPath(import.meta.url))
/**
 * Onde o build vai parar.
 *
 * `--outdir <caminho>` escreve numa pasta à escolha. O `dist` compartilhado é
 * apagado no começo do build, e um teste que está rodando com a extensão
 * carregada perde os arquivos no meio do caminho. Uma cópia particular
 * resolve: cada execução constrói a sua e ninguém atrapalha ninguém.
 */
const outdirArg = process.argv.indexOf("--outdir")
const outdir = outdirArg >= 0 ? resolve(process.argv[outdirArg + 1]) : join(root, "dist")
const watch = process.argv.includes("--watch")

rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })

const common = {
  bundle: true,
  sourcemap: false,
  minify: !watch,
  logLevel: "info",
  target: ["chrome116"],
  define: { "process.env.NODE_ENV": '"production"' },
}

const builds = [
  {
    ...common,
    entryPoints: [join(root, "src/background/index.ts")],
    outfile: join(outdir, "background.js"),
    format: "esm",
  },
  {
    ...common,
    entryPoints: [join(root, "src/content/index.ts")],
    outfile: join(outdir, "content.js"),
    format: "iife",
  },
  {
    ...common,
    entryPoints: [join(root, "src/panel/main.ts")],
    outfile: join(outdir, "panel.js"),
    format: "esm",
  },
]

function copyStatic() {
  cpSync(join(root, "manifest.json"), join(outdir, "manifest.json"))
  cpSync(join(root, "src/panel/index.html"), join(outdir, "panel.html"))
  cpSync(join(root, "src/styles.css"), join(outdir, "styles.css"))
}

if (watch) {
  copyStatic()
  const contexts = await Promise.all(builds.map((options) => context(options)))
  await Promise.all(contexts.map((ctx) => ctx.watch()))
  console.log("assistindo mudanças...")
} else {
  await Promise.all(builds.map((options) => build(options)))
  copyStatic()
  console.log(`extensão gerada em ${resolve(outdir)}`)
}
