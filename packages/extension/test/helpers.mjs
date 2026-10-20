/**
 * Utilidades compartilhadas pelos testes end-to-end da extensão.
 *
 * Arquivo JavaScript puro: os e2e rodam com `node`, sem etapa de
 * compilação — anotação de tipo aqui quebraria a execução.
 */
import { resolve } from "node:path"

/** Endereço padrão do servidor local. */
export const SERVER_URL = process.env.GRIVER_SERVER_URL ?? "http://127.0.0.1:7331"

/**
 * Endereço do servidor para um e2e rodando sozinho.
 *
 * O padrão da casa (7331) é o servidor de desenvolvimento, com o banco de
 * verdade: um teste que cria e apaga projetos deixa lixo no banco do
 * usuário e a lista de receitas enche de "Script do teste". Sem endereço, o
 * teste não roda — a suíte completa sobe um servidor isolado e passa o
 * dele; para rodar um teste só, aponte para um servidor descartável.
 */
export function servidorDoTeste(argumentos) {
  const url = argumentos?.[0]
  if (!url) {
    throw new Error(
      "informe o servidor: node packages/extension/test/<teste>.e2e.mjs <serverUrl>\n" +
        "sem endereço o padrão é o servidor de desenvolvimento (7331), com o banco de verdade — " +
        "o teste deixaria projetos e receitas de teste no banco do usuário",
    )
  }
  return url
}

/**
 * Tem tela para o Chrome?
 *
 * No Linux, o Chrome de verdade (headed) precisa de um X server: sem
 * `DISPLAY` ele morre na largada com "Missing X server or $DISPLAY".
 */
export function temTela() {
  if (process.platform !== "linux") return true
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
}

/**
 * O e2e roda sem tela?
 *
 * O Playwright tem dois Chromium: o "headless shell", que é o padrão do
 * `headless: true` e não carrega extensão nenhuma, e o Chromium completo,
 * que roda a extensão MV3 em headless como qualquer outro.
 *
 * O `channel: "chromium"` é o que escolhe o binário completo. Sem ele, o
 * service worker da extensão nunca aparece e o teste morre fingindo que a
 * extensão não carregou.
 *
 * Headless é o padrão: o Chrome de verdade depende de um X server e
 * morre sozinho quando o Xwayland engasga — o teste falha com "Target
 * page, context or browser has been closed", sem dizer que o culpado é o
 * navegador. `GRIVER_HEADLESS=0` pede o Chrome de verdade (e aí a tela
 * é obrigatória).
 */
export const HEADLESS = process.env.GRIVER_HEADLESS !== "0"

/**
 * Opções do navegador dos e2e.
 *
 * `channel: "chromium"` é obrigatório: ele traz o Chromium completo, o
 * único que carrega extensão MV3 em headless.
 */
export function opcoesDoNavegador(extra = {}) {
  return {
    headless: HEADLESS,
    channel: "chromium",
    ...extra,
  }
}

/**
 * Falha cedo quando não há tela para o Chrome.
 *
 * Antes isso era um beco sem saída: sem `DISPLAY` no Linux, o navegador
 * morre na largada com "Missing X server or $DISPLAY" e a suíte inteira
 * falha com nove erros que não dizem nada sobre a causa — o problema não
 * é o código, é a tela que sumiu (login novo, sessão sem Wayland, `sudo`
 * sem o display do usuário).
 *
 * Agora a tela que falta vira headless. O erro só sobra quando alguém
 * pediu o Chrome de verdade (`GRIVER_HEADLESS=0`) e a tela não existe.
 */
export function exigeDisplay() {
  if (temTela()) return
  if (HEADLESS) {
    console.log("sem tela: os e2e rodam headless (GRIVER_HEADLESS=0 pede o Chrome de verdade)")
    return
  }

  console.error(
    "os testes e2e precisam de uma tela: o Chrome de verdade não abre sem ela.\n" +
      "  export DISPLAY=:1   (o Xwayland do seu login)\n" +
      "  ou rode com xvfb-run: xvfb-run -a node packages/extension/test/e2e-all.mjs\n" +
      "  ou deixe o headless assumir: pnpm test:e2e:all",
  )
  process.exit(1)
}

/**
 * Garante que o navegador feche se o teste falhar no meio.
 *
 * Um Chrome órfão continua conectado ao servidor e capturando eventos: os
 * passos de um teste aparecem na gravação do seguinte, e a receita sai com
 * passos que nunca aconteceram.
 */
export function fecharAoFalhar(context) {
  const encerrar = async () => {
    try {
      await context.close()
    } catch {
      // o navegador já estava fechado
    }
  }

  process.on("uncaughtException", async (erro) => {
    await encerrar()
    console.error(erro)
    process.exit(1)
  })

  process.on("unhandledRejection", async (erro) => {
    await encerrar()
    console.error(erro)
    process.exit(1)
  })
}

/**
 * Espera a extensão ficar conectada ao servidor.
 *
 * Sem isso, um teste pode começar a gravar antes da conexão subir — e nada
 * é registrado, sem nenhuma indicação do motivo.
 */
export async function esperaConectado(panel, tentativas = 20) {
  for (let tentativa = 0; tentativa < tentativas; tentativa++) {
    await panel.waitForTimeout(500)
    const online = await panel.evaluate(() => Boolean(document.querySelector(".status-online")))
    if (online) return true
  }
  return false
}

/**
 * Aponta a extensão para um servidor antes de o painel abrir.
 *
 * O painel nasce com o endereço padrão (7331) e já sai buscando receitas e
 * token. Gravar o endereço antes evita as chamadas ao servidor errado — que
 * viram erro de console e, num token de outro servidor, 401.
 */
export async function apontaParaServidor(worker, serverUrl = SERVER_URL) {
  await worker.evaluate(async ([url]) => {
    // o token guardado é do servidor anterior: ele não autentica neste
    await chrome.storage.local.set({ "griver.serverUrl": url, "griver.token": "" })
  }, [serverUrl])
}

/**
 * Conecta a extensão ao servidor.
 *
 * O botão "Conectar" fica na tela de Ajustes — o painel abre em Receitas.
 *
 * O endereço vai pelo campo de texto, e não direto para o storage: o painel
 * guarda o servidor numa variável em memória e usa o valor de lá ao
 * conectar. Escrever no storage por baixo dos panos deixa o painel
 * apontando para o servidor padrão (7331) — a extensão conecta na porta
 * errada e as chamadas depois levam 401.
 */
export async function conectar(panel, serverUrl = SERVER_URL) {
  await panel.evaluate(() => {
    document.querySelector('.panel-header button[title="Ajustes"]')?.click()
  })
  await panel.waitForTimeout(400)

  const digitou = await panel.evaluate((url) => {
    const campo = Array.from(document.querySelectorAll("label.field")).find(
      (l) => l.querySelector(".field-label")?.textContent?.trim() === "Servidor",
    )
    const input = campo?.querySelector("input")
    if (!input) return false
    input.value = url
    input.dispatchEvent(new Event("input", { bubbles: true }))
    return true
  }, serverUrl)
  if (!digitou) return false

  await panel.evaluate(() => {
    Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent?.trim() === "Conectar")
      ?.click()
  })

  const online = await esperaConectado(panel)
  if (!online) return false

  // volta para Receitas, que é a tela inicial
  await panel.evaluate(() => {
    document.querySelector('.panel-header button[title="Receitas"]')?.click()
  })
  await panel.waitForTimeout(400)
  return true
}

/**
 * Acha a aba do teste pelo endereço.
 *
 * Pegar a aba ativa depende do foco da janela: com outro Chrome na tela, o
 * foco muda de janela e a injeção cai numa aba que já morreu — o Chrome
 * responde "Frame with ID 0 was removed" e o teste falha sem ter nada a ver
 * com o código. A aba do teste é achada pelo endereço, que não muda com o
 * foco.
 *
 * Devolve `null` quando a aba não aparece: aí o teste diz o que faltou em
 * vez de fingir que a permissão de host falhou.
 */
export async function achaAba(worker, url, tentativas = 20) {
  return await worker.evaluate(
    async ([alvo, quantas]) => {
      for (let tentativa = 0; tentativa < quantas; tentativa++) {
        const abas = await chrome.tabs.query({})
        const achada = abas.find((aba) => aba.url && aba.url.startsWith(alvo))
        // a aba existe e a página carregou: dá para injetar
        if (achada && achada.status === "complete") {
          return { id: achada.id, url: achada.url }
        }
        await new Promise((resolver) => setTimeout(resolver, 250))
      }
      return null
    },
    [url, tentativas],
  )
}

/**
 * Caminho da extensão carregada no Chrome.
 *
 * `GRIVER_EXTENSION_PATH` aponta para uma cópia do build: outra execução
 * pode regerar o `dist` no meio do teste e trocar os arquivos debaixo do
 * navegador.
 */
export const EXTENSION_PATH = resolve(
  process.env.GRIVER_EXTENSION_PATH ?? "packages/extension/dist",
)

