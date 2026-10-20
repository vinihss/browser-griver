/**
 * Teste da operação do Griver pela linha de comando.
 *
 * Cobre a cadeia inteira: a CLI fala com o servidor, o servidor comanda a
 * extensão, a extensão captura os eventos da página e a receita volta
 * pronta para a CLI. É o caminho que o comando `griver record` percorre.
 *
 * Uso: node packages/extension/test/record-cli.e2e.mjs <serverUrl>
 */
import { chromium } from "playwright"
import { execFile } from "node:child_process"
import { mkdtempSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { EXTENSION_PATH, apontaParaServidor, conectar, fecharAoFalhar, opcoesDoNavegador, servidorDoTeste } from "./helpers.mjs"

const execFileAsync = promisify(execFile)

const extensionPath = EXTENSION_PATH
const serverUrl = servidorDoTeste(process.argv.slice(2))

/**
 * A CLI: o `dist` quando existe, o código-fonte senão.
 *
 * O binário compilado é o que o usuário digita; o `tsx` cobre o caso de
 * quem roda a suíte sem compilar antes.
 */
const CLI_DIST = resolve("packages/cli/dist/index.js")
const CLI_SRC = resolve("packages/cli/src/index.ts")
const usaTsx = existsSync(CLI_DIST) ? false : true

const userDataDir = mkdtempSync(join(tmpdir(), "griver-cli-"))

const siteDir = mkdtempSync(join(tmpdir(), "griver-site-"))
const pagina = join(siteDir, "a.html")
writeFileSync(
  pagina,
  `<!doctype html><meta charset="utf-8"><title>CLI</title>
   <h1>Alvo</h1><input id="campo" /><button id="botao">Enviar</button>
   <p id="resultado"></p>
   <script>
     document.querySelector("#botao").addEventListener("click", () => {
       document.querySelector("#resultado").textContent = "recebido: " + document.querySelector("#campo").value
     })
   </script>`,
)

const context = await chromium.launchPersistentContext(userDataDir, {
  ...opcoesDoNavegador(),
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
})

fecharAoFalhar(context)

const erros = []
let worker = context.serviceWorkers()[0]
if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 })

await apontaParaServidor(worker, serverUrl)

const panel = await context.newPage()
panel.on("pageerror", (error) => erros.push(`panel: ${error.message}`))

const page = await context.newPage()
page.on("pageerror", (error) => erros.push(`page: ${error.message}`))

await page.goto(`file://${pagina}`)
await page.waitForTimeout(400)
await panel.goto(`chrome-extension://${new URL(worker.url()).host}/panel.html`)
await panel.waitForSelector(".panel-header", { timeout: 15000 })
await panel.waitForTimeout(400)

const online = await conectar(panel, serverUrl)
console.log("1. extensão conectada:", online ? "sim" : "NÃO")

// o token é o mesmo que a extensão usa: a CLI lê o do armazenamento
const token = await panel.evaluate(async () => {
  const guardado = await chrome.storage.local.get("griver.token")
  return guardado["griver.token"] ?? ""
})
console.log("1. token:", token ? "sim" : "NÃO")

/** Roda a CLI como o usuário roda. */
async function cli(...args) {
  const comando = usaTsx
    ? [resolve("node_modules/.bin/tsx"), CLI_SRC, ...args]
    : [CLI_DIST, ...args]
  const { stdout, stderr } = await execFileAsync(process.execPath, comando, {
    env: { ...process.env, GRIVER_SERVER_URL: serverUrl, GRIVER_TOKEN: token },
  })
  return { stdout, stderr }
}

// ── 2. a CLI lê a página ────────────────────────────────────────────────────
const contexto = await cli("page", "context")
// a saída traz o título e o endereço da aba ativa
console.log("2. a CLI leu a aba:", contexto.stdout.includes("CLI") ? "sim" : "NÃO")
console.log("   contexto:", contexto.stdout.split("\n").slice(0, 2).join(" | ").trim())

// ── 3. a CLI comanda a gravação ────────────────────────────────────────────
const inicio = await cli("record", "start")
console.log("3. gravação iniciada:", inicio.stdout.includes("Gravando") ? "sim" : `NÃO (${inicio.stderr})`)

// a extensão leva um instante para ligar o gravador na aba
await page.bringToFront()
await page.waitForTimeout(1500)

// ── 4. a interação na página vira passo ────────────────────────────────────
await cli("page", "click", "#campo")
await cli("page", "fill", "#campo", "valor pela cli")
await page.waitForTimeout(1200)

const estado = await cli("record", "state")
const eventos = Number(estado.stdout.match(/(\d+) evento/)?.[1] ?? "0")
console.log("4. eventos capturados:", eventos)

// ── 5. a gravação para e devolve a receita ──────────────────────────────────
const parada = await cli("record", "stop")
console.log("5. passos na saída:\n" + parada.stdout.split("\n").slice(0, 8).join("\n"))

const estadoFinal = await cli("record", "state")
console.log("6. estado final:", estadoFinal.stdout.trim())

await context.close()

const ok =
  online &&
  contexto.stdout.includes("CLI") &&
  inicio.stdout.includes("Gravando") &&
  eventos > 0 &&
  parada.stdout.includes("passos gravados") &&
  erros.length === 0

console.log("\nerros de runtime:", erros.length ? erros.join(" | ") : "nenhum")
console.log(ok ? "\n✓ cli ok" : "\n✗ cli com problemas")
process.exit(ok ? 0 : 1)
