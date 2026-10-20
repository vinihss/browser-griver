/**
 * Utilidades compartilhadas pelos testes end-to-end da extensão.
 *
 * Arquivo JavaScript puro: os e2e rodam com `node`, sem etapa de
 * compilação — anotação de tipo aqui quebraria a execução.
 */

/** Endereço padrão do servidor local. */
export const SERVER_URL = process.env.GRIVER_SERVER_URL ?? "http://127.0.0.1:7331"

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
 * Conecta a extensão ao servidor.
 *
 * O botão "Conectar" fica na tela de Ajustes — o painel abre em Receitas.
 */
export async function conectar(panel, serverUrl = SERVER_URL) {
  await panel.evaluate(async ([url]) => {
    await chrome.storage.local.set({ "griver.serverUrl": url })
    document.querySelector('.panel-header button[title="Ajustes"]')?.click()
  }, [serverUrl])
  await panel.waitForTimeout(400)

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
