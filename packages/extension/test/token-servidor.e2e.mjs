/**
 * O painel tem que usar o token do servidor que ele aponta.
 *
 * O token guardado no navegador é do servidor anterior: quando a extensão
 * troca de servidor, o guardado continua válido no antigo e o painel tomava
 * 401 em toda chamada — abrindo vazio, sem dizer o motivo. Aqui o token
 * velho é plantado de propósito e o painel tem que se recuperar sozinho,
 * sem o usuário precisar clicar em "Conectar".
 */
import { chromium } from "playwright"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXTENSION_PATH, fecharAoFalhar } from "./helpers.mjs"

const extensionPath = EXTENSION_PATH
const serverUrl = process.argv[2] ?? "http://127.0.0.1:7331"

/** Token de outro servidor: vale no servidor antigo, não neste. */
const TOKEN_ANTIGO = "token-de-outro-servidor"

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "griver-token-")), {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
  ],
})

fecharAoFalhar(context)

let worker = context.serviceWorkers()[0]
if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 })

const tokenDoServidor = await fetch(`${serverUrl}/api/extension-token`).then((r) => r.json())

/**
 * Espera o service worker guardar o token do servidor.
 *
 * Ele renova o token quando se conecta — e essa renovação acontece antes do
 * painel abrir. Sem esperar, o token velho seria plantado antes da renovação
 * e o service worker a desfaria: o teste passaria sem exercitar o bug.
 */
async function tokenGuardado(): Promise<string> {
  return await worker.evaluate(async () => {
    const guardado = await chrome.storage.local.get("griver.token")
    return (guardado["griver.token"] as string) ?? ""
  })
}

let renovation = ""
for (let tentativa = 0; tentativa < 40; tentativa++) {
  renovation = await tokenGuardado()
  if (renewal === tokenDoServidor.token) break
  await new Promise((r) => setTimeout(r, 250))
}
console.log("0. service worker guardou o token do servidor:", renovation === tokenDoServidor.token ? "sim" : "NÃO")

// agora planta o token velho: o endereço é o do servidor do teste, mas o
// token guardado é de outro — o estado em que a extensão fica depois de
// trocar de servidor
await worker.evaluate(
  async ([url, velho]) => {
    await chrome.storage.local.set({ "griver.serverUrl": url, "griver.token": velho })
  },
  [serverUrl, TOKEN_ANTIGO],
)

const painel = await context.newPage()
const erros = []
painel.on("console", (mensagem) => {
  if (mensagem.type() === "error") erros.push(mensagem.text())
})
painel.on("pageerror", (erro) => erros.push(erro.message))

await painel.goto(`chrome-extension://${new URL(worker.url()).host}/panel.html`)
await painel.waitForSelector(".panel-header", { timeout: 15000 })

// a lista de receitas vem do servidor: ela só aparece se o token valer
let linhas = 0
for (let tentativa = 0; tentativa < 20 && linhas === 0; tentativa++) {
  await painel.waitForTimeout(500)
  linhas = await painel.evaluate(() => document.querySelectorAll(".recipe-row").length)
}

const renovou = (await tokenGuardado()) !== TOKEN_ANTIGO
const sem401 = !erros.some((linha) => linha.includes("401"))

console.log("1. receitas listadas:", linhas)
console.log("2. token guardado:", renovou ? "renovado" : "ainda o velho")
console.log("3. erros de 401:", sem401 ? "nenhum" : erros.join(" | "))

await context.close()

console.log(`\nreceitas: ${linhas > 0 ? "ok" : "FALHOU"}`)
console.log(`token: ${renovou ? "renovado" : "FALHOU"}`)
console.log(`401: ${sem401 ? "nenhum" : "FALHOU"}`)

process.exit(linhas > 0 && renovou && sem401 ? 0 : 1)
