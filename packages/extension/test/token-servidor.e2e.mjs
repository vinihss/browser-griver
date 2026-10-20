/**
 * O painel tem que usar o token do servidor que ele aponta.
 *
 * O token guardado no navegador é do servidor anterior: quando a extensão
 * troca de servidor, o guardado continua válido no antigo e o painel tomava
 * 401 em toda chamada — abrindo vazio, sem dizer o motivo. Aqui o token
 * velho é plantado de propósito e o painel tem que se recuperar sozinho,
 * sem o usuário precisar clicar em "Conectar".
 *
 * O token novo é entregue com atraso de propósito (o proxy abaixo): o
 * service worker renova o token em segundo plano, e sem o atraso o painel
 * lê o token velho antes da renovação — a corrida decide o resultado do
 * teste, não o código.
 */
import { chromium } from "playwright"
import { mkdtempSync } from "node:fs"
import { createServer, request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXTENSION_PATH, fecharAoFalhar, opcoesDoNavegador, servidorDoTeste } from "./helpers.mjs"

const extensionPath = EXTENSION_PATH
const serverUrl = servidorDoTeste(process.argv.slice(2))

/** Token de outro servidor: vale no servidor antigo, não neste. */
const TOKEN_ANTIGO = "token-de-outro-servidor"

/** Quanto o proxy segura o token novo antes de entregar. */
const ATRASO_TOKEN_MS = 1500

const destino = new URL(serverUrl)

/**
 * Proxy entre a extensão e o servidor.
 *
 * Só o token atrasa: é a resposta que o service worker usa para renovar o
 * token guardado, e o painel precisa de tempo para ver o token velho.
 */
const proxy = createServer((req, res) => {
  const encaminhar = () => {
    const chamada = httpRequest(
      {
        hostname: destino.hostname,
        port: destino.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (resposta) => {
        res.writeHead(resposta.statusCode ?? 502, resposta.headers)
        resposta.pipe(res)
      },
    )
    chamada.on("error", () => {
      res.writeHead(502)
      res.end()
    })
    req.pipe(chamada)
  }

  if (req.url?.startsWith("/api/extension-token")) {
    setTimeout(encaminhar, ATRASO_TOKEN_MS)
  } else {
    encaminhar()
  }
})
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve))
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`

/**
 * O WebSocket também é encaminhado.
 *
 * Sem isso a extensão não conecta, cai num laço de reconexão e renova o
 * token o tempo todo — o token velho plantado seria apagado antes de o
 * painel chegar a lê-lo, e o teste passaria sem exercitar o bug.
 */
proxy.on("upgrade", (req, socket, head) => {
  const chamada = httpRequest({
    hostname: destino.hostname,
    port: destino.port,
    path: req.url,
    method: req.method,
    headers: req.headers,
  })
  chamada.on("upgrade", (resposta, socketDestino, headDestino) => {
    const cabecalhos = Object.entries(resposta.headers)
      .map(([chave, valor]) => `${chave}: ${valor}`)
      .join("\r\n")
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${cabecalhos}\r\n\r\n`)
    if (headDestino?.length) socket.write(headDestino)
    socketDestino.pipe(socket).pipe(socketDestino)
  })
  chamada.on("error", () => socket.destroy())
  if (head?.length) chamada.write(head)
  chamada.end()
})

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "griver-token-")), {
  ...opcoesDoNavegador(),
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

/**
 * Token guardado pela extensão.
 *
 * O storage vive no service worker: a página do painel não tem a API.
 */
async function tokenGuardado() {
  return await worker.evaluate(async () => {
    const guardado = await chrome.storage.local.get("griver.token")
    return guardado["griver.token"] ?? ""
  })
}

const painel = await context.newPage()
const erros = []
painel.on("console", (mensagem) => {
  if (mensagem.type() === "error") erros.push(mensagem.text())
})
painel.on("pageerror", (erro) => erros.push(erro.message))

// ── 1. a extensão se conecta ao servidor do teste ───────────────────────────
await worker.evaluate(async ([url]) => {
  await chrome.storage.local.set({ "griver.serverUrl": url, "griver.token": "" })
}, [proxyUrl])

await painel.goto(`chrome-extension://${new URL(worker.url()).host}/panel.html`)
await painel.waitForSelector(".panel-header", { timeout: 15000 })

// o service worker renova o token quando o painel pergunta o status
let guardado = ""
for (let tentativa = 0; tentativa < 40; tentativa++) {
  guardado = await tokenGuardado()
  if (guardado) break
  await new Promise((r) => setTimeout(r, 250))
}
console.log("0. service worker guardou um token:", guardado ? "sim" : "NÃO")

// ── 2. o token velho é plantado depois da renovação ─────────────────────────
// sem esperar a renovação, o service worker desfaria o plantão e o teste
// passaria sem exercitar o bug
await worker.evaluate(
  async ([velho]) => {
    await chrome.storage.local.set({ "griver.token": velho })
  },
  [TOKEN_ANTIGO],
)

// ── 3. o painel nasce com o token velho ─────────────────────────────────────
erros.length = 0
await painel.reload()
await painel.waitForSelector(".panel-header", { timeout: 15000 })

// a lista de receitas vem do servidor: ela só aparece se o token valer
let linhas = 0
for (let tentativa = 0; tentativa < 30 && linhas === 0; tentativa++) {
  await painel.waitForTimeout(500)
  linhas = await painel.evaluate(() => document.querySelectorAll(".recipe-row").length)
}

const renovou = (await tokenGuardado()) !== TOKEN_ANTIGO
const unauthorized = erros.filter((linha) => linha.includes("401")).length

console.log("1. receitas listadas:", linhas)
console.log("2. token guardado:", renovou ? "renovado" : "ainda o velho")
// o primeiro pedido leva o token velho e é recusado — o painel renova e
// tenta de novo. O que não pode é ficar presa no token velho.
console.log("3. pedidos recusados com 401:", unauthorized)

await context.close()
proxy.close()

console.log(`\nreceitas: ${linhas > 0 ? "ok" : "FALHOU"}`)
console.log(`token: ${renovou ? "renovado" : "FALHOU"}`)

process.exit(linhas > 0 && renovou ? 0 : 1)
