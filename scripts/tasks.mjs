#!/usr/bin/env node
/**
 * Ponto único das tarefas do Griver.
 *
 * Tudo o que o projeto sabe fazer passa por aqui: instalar, compilar,
 * testar, empacotar, linkar o CLI e subir o servidor. Os atalhos do
 * `package.json` chamam este arquivo e o `bin/griver` também — assim há um
 * lugar só para o fluxo de trabalho, e o mesmo comando serve na máquina de
 * desenvolvimento e na CI.
 *
 * As tarefas usam caminhos absolutos: quem chama o script pode estar em
 * qualquer pasta (o link global do `griver` chama daqui), e o diretório de
 * onde o processo foi chamado continua valendo para o servidor — a pasta de
 * dados segue o `cwd`, não a raiz do repositório.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** Executa um comando e deixa a saída na tela. */
function run(comando, args, opcoes = {}) {
  console.log(`\n▸ ${comando} ${args.join(" ")}`)
  return execFileSync(comando, args, {
    cwd: opcoes.cwd ?? raiz,
    stdio: "inherit",
    env: { ...process.env, ...opcoes.env },
  })
}

/** Executa um comando em primeiro plano e devolve o código de saída. */
function foreground(comando, args, opcoes = {}) {
  const resultado = spawnSync(comando, args, {
    cwd: opcoes.cwd ?? raiz,
    stdio: "inherit",
    env: { ...process.env, ...opcoes.env },
  })
  return resultado.status ?? 1
}

/** O executável de um binário do workspace. */
function bin(nome) {
  return join(raiz, "node_modules", ".bin", nome)
}

/**
 * Deixa um arquivo executável.
 *
 * O link global do `griver` aponta para o `dist/index.js` do CLI. O `npm
 * link` deixa o arquivo executável quando cria o link, mas um build
 * posterior reescreve o arquivo e o modo volta a 644 — e o comando global
 * passa a responder "Permission denied" sem explicação. O bit é das
 * dependências do bin, então quem compila é quem tem que sustentá-lo.
 */
function marcarExecutavel(caminho) {
  if (!existsSync(caminho)) return
  chmodSync(caminho, 0o755)
}

/** Os arquivos de teste de um pacote. */
function testesDo(workspace) {
  const pasta = join(raiz, "packages", workspace, "test")
  if (!existsSync(pasta)) return []
  return readdirSync(pasta)
    .filter((nome) => nome.endsWith(".test.ts"))
    .map((nome) => join(pasta, nome))
    .sort()
}

// ── tarefas ─────────────────────────────────────────────────────────────────

/** Compila os pacotes do workspace e empacota a extensão. */
function compilar() {
  run(bin("tsc"), ["-b", "packages/core", "packages/server", "packages/cli"])
  run(process.execPath, [join(raiz, "packages", "extension", "build.mjs")])
  marcarExecutavel(join(raiz, "packages", "cli", "dist", "index.js"))
  console.log("\nbuild concluído")
  console.log(`  extensão: ${join(raiz, "packages", "extension", "dist")}`)
  console.log(`  cli:      ${join(raiz, "packages", "cli", "dist", "index.js")}`)
}

/** Confere os tipos de tudo, inclusive da extensão (que não é `tsc -b`). */
function conferirTipos() {
  run(bin("tsc"), ["-b", "packages/core", "packages/server", "packages/cli"])
  run(bin("tsc"), ["--noEmit", "-p", "packages/extension/tsconfig.json"])
}

/** Os testes unitários dos três pacotes. */
function testar() {
  const arquivos = ["core", "server", "extension"].flatMap(testesDo)
  if (!arquivos.length) {
    console.log("nenhum teste encontrado")
    return
  }
  run(bin("tsx"), ["--test", ...arquivos])
}

/**
 * A suíte end-to-end, com navegador de verdade.
 *
 * Headless é o padrão: o Chrome de verdade depende de um X server e morre
 * sozinho quando o Xwayland engasga — o teste falha com "Target page,
 * context or browser has been closed", sem dizer que o culpado é o
 * navegador.
 */
function testarE2e() {
  run(process.execPath, [join(raiz, "packages", "extension", "test", "e2e-all.mjs")], {
    env: { GRIVER_HEADLESS: process.env.GRIVER_HEADLESS ?? "1" },
  })
}

/**
 * O zip da extensão, para quem instala pela Chrome Web Store ou por
 * download.
 *
 * Os arquivos vêm do `dist` da extensão, e não de uma lista escrita à mão:
 * a lista duplicada envelhecia e o zip saía sem o arquivo novo.
 */
function empacotar() {
  const dist = join(raiz, "packages", "extension", "dist")
  if (!existsSync(dist)) {
    throw new Error("a extensão não está compilada — rode `pnpm build` antes")
  }
  const destino = join(raiz, "griver-extension.zip")
  const arquivos = readdirSync(dist).map((nome) => join(dist, nome))
  rmSync(destino, { force: true })
  run("zip", ["-j", "-q", destino, ...arquivos])
  console.log(`\n  zip: ${destino}`)
}

/**
 * Linka o CLI no diretório global de binários.
 *
 * O `npm link` cria dois symlinks: o pacote em
 * `<prefixo>/lib/node_modules/@griver/cli` e o comando `griver` em
 * `<prefixo>/bin`. O bin aponta para o `dist` do CLI — por isso o build vem
 * antes do link, e o bit de execução é conferido depois de cada build.
 */
function linkar() {
  const cli = join(raiz, "packages", "cli")
  const dist = join(cli, "dist", "index.js")
  if (!existsSync(dist)) {
    console.log("o CLI não está compilado — compilando antes de linkar")
    compilar()
  }
  marcarExecutavel(dist)
  run("npm", ["link"], { cwd: cli })
  const prefixo = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim()
  console.log(`\n  griver: ${join(prefixo, "bin", "griver")}`)
  console.log("  (para desfazer: npm unlink -g @griver/cli)")
}

/**
 * Instala as dependências.
 *
 * Com rede, o `pnpm install` resolve tudo pelo lockfile. Sem rede — o caso
 * do ambiente de desenvolvimento desta máquina — ele falha, e o script
 * `vendor-offline.mjs` copia os pacotes disponíveis na máquina. A ordem
 * importa: o pnpm primeiro, o vendor como reserva.
 */
function instalar() {
  if (existsSync(bin("tsc")) && existsSync(bin("tsx"))) {
    console.log("dependências já instaladas")
    return
  }
  console.log("instalando dependências (pnpm)")
  try {
    run("pnpm", ["install", "--frozen-lockfile"])
    return
  } catch {
    console.log("\no pnpm não conseguiu instalar — resorting para o vendor offline")
  }
  run(process.execPath, [join(raiz, "scripts", "vendor-offline.mjs")])
}

/**
 * O caminho completo: instalar, compilar, linkar e empacotar.
 *
 * É o que um clone novo precisa para virar uma máquina de trabalho: as
 * dependências no lugar, o build em dia e o comando `griver` disponível
 * em qualquer pasta.
 *
 * O nome é `bootstrap` e não `setup` porque o pnpm já tem o seu `setup` —
 * ele instala o pnpm globalmente, e quem digita `pnpm setup` esperando o
 * Griver recebe outra coisa. Mesma razão para `deps` (em vez de `install`)
 * e `link-cli` (em vez de `link`).
 */
function instalarTudo() {
  instalar()
  compilar()
  linkar()
  empacotar()
  console.log("\npronto")
  console.log("  servidor:  griver serve")
  console.log("  extensão:  packages/extension/dist (chrome://extensions → Carregar sem compactação)")
  console.log("  diagnóstico: griver doctor")
}

/** Limpa o que é build: dist, tsbuildinfo e o zip. */
function limpar() {
  const alvos = [
    join(raiz, "packages", "core", "dist"),
    join(raiz, "packages", "server", "dist"),
    join(raiz, "packages", "cli", "dist"),
    join(raiz, "packages", "extension", "dist"),
    join(raiz, "griver-extension.zip"),
  ]
  for (const alvo of alvos) {
    if (!existsSync(alvo)) continue
    rmSync(alvo, { recursive: true, force: true })
    console.log(`  removido: ${alvo.replace(`${raiz}/`, "")}`)
  }
  for (const pacote of ["core", "server", "cli"]) {
    const info = join(raiz, "packages", pacote, "tsconfig.tsbuildinfo")
    if (!existsSync(info)) continue
    rmSync(info, { force: true })
    console.log(`  removido: packages/${pacote}/tsconfig.tsbuildinfo`)
  }
}

/** Sobe o servidor local em desenvolvimento. */
function servir() {
  const codigo = foreground(bin("tsx"), [join(raiz, "packages", "server", "src", "main.ts")])
  process.exitCode = codigo
}

/** Roda a CLI a partir do fonte, sem build. */
function cli(args) {
  const codigo = foreground(bin("tsx"), [join(raiz, "packages", "cli", "src", "index.ts"), ...args])
  process.exitCode = codigo
}

/**
 * O loop de desenvolvimento: a extensão recompilando e o servidor no ar.
 *
 * A extensão é o que precisa de vigia — o service worker é recarregado pelo
 * Chrome, e cada build trocaria os arquivos debaixo do navegador. O
 * watcher monta numa pasta à parte, e o servidor sobe uma vez só.
 */
function desenvolver() {
  const watcher = spawn(
    process.execPath,
    [join(raiz, "packages", "extension", "build.mjs"), "--watch"],
    { cwd: raiz, stdio: "inherit" },
  )
  const encerrar = () => watcher.kill()
  process.on("SIGINT", encerrar)
  process.on("SIGTERM", encerrar)
  watcher.on("exit", encerrar)

  servir()
}

// ── despacho ────────────────────────────────────────────────────────────────

const TAREFAS = {
  bootstrap: instalarTudo,
  deps: instalar,
  build: compilar,
  typecheck: conferirTipos,
  test: testar,
  e2e: testarE2e,
  package: empacotar,
  "link-cli": linkar,
  clean: limpar,
  serve: servir,
  cli,
  dev: desenvolver,
  vendor: () => run(process.execPath, [join(raiz, "scripts", "vendor-offline.mjs")]),
}

const [tarefa, ...args] = process.argv.slice(2)

if (!tarefa || tarefa === "help" || tarefa === "--help") {
  console.log(`
griver — tarefas do projeto

  bootstrap  instala, compila, linka o CLI e empacota a extensão
  deps       instala as dependências (pnpm, com vendor offline de reserva)
  build      compila core, server, cli e a extensão
  typecheck  confere os tipos de tudo, inclusive da extensão
  test       roda os testes unitários
  e2e        roda a suíte end-to-end (Chromium de verdade, headless)
  package    gera o griver-extension.zip
  link-cli   linka o CLI no diretório global de binários
  clean      remove dist, tsbuildinfo e o zip
  serve      sobe o servidor local
  cli        roda a CLI a partir do fonte
  dev        extensão em watch + servidor no ar
`)
  process.exit(0)
}

const acao = TAREFAS[tarefa]
if (!acao) {
  console.error(`tarefa desconhecida: ${tarefa}`)
  console.error("use `node scripts/tasks.mjs help` para ver as disponíveis")
  process.exit(1)
}

try {
  await acao(args)
} catch (erro) {
  console.error(erro instanceof Error ? erro.message : String(erro))
  process.exit(1)
}
