import { readFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { startServer, SERVER_VERSION, type GriverServer } from "./index.js"
import { encerrarOrfaos, lerProcesso } from "./orfaos.js"
import { loadConfig, type ServerConfig } from "./config.js"

/**
 * A porta está livre?
 *
 * O pid do servidor morto não diz se a porta já voltou: quem segura o
 * socket pode ser o filho que sobreviveu ao pai. A pergunta certa é se
 * ainda tem alguém escutando.
 */
export function portaLivre(porta: number, host: string): Promise<boolean> {
  return new Promise((resolver) => {
    const servidor = createServer()
    servidor.once("error", () => resolver(false))
    servidor.once("listening", () => servidor.close(() => resolver(true)))
    servidor.listen(porta, host)
  })
}

/**
 * Espera a porta ficar livre.
 *
 * O servidor novo só sobe se a porta estiver livre: occupied é EADDRINUSE,
 * e o servidor morre na largada.
 */
export async function esperarPortaLivre(
  porta: number,
  host: string,
  timeoutMs = 5000,
): Promise<boolean> {
  const limite = Date.now() + timeoutMs
  while (true) {
    if (await portaLivre(porta, host)) return true
    if (Date.now() >= limite) return false
    await new Promise((resolver) => setTimeout(resolver, 100))
  }
}

/**
 * Sobe o servidor e mantém o processo vivo.
 *
 * Usado tanto pelo binário `griver-server` quanto por `griver serve`, para
 * que os dois imprimam a mesma orientação.
 */
export async function runServer(overrides: Partial<ServerConfig> = {}): Promise<GriverServer> {
  const guardiao = guardiaoDaCadeia()
  const criador = criadorDaSessao()
  const config = loadConfig(overrides)

  // servidor que sobrou de uma execução anterior: o shell que o started
  // morreu e ele ficou de pé, segurando a porta e a memória. Antes de
  // pegar a porta, ele sai da frente.
  const orfaos = await encerrarOrfaos()
  if (orfaos.length > 0) {
    console.log(`servidores órfãos encerrados: ${orfaos.map((orfao) => orfao.pid).join(", ")}`)
    // a porta é o que importa: o pid pode ter morrido e o socket continuar
    // na mão de quem sobrou da cadeia
    const liberada = await esperarPortaLivre(config.port, config.host)
    if (!liberada) {
      console.log(`a porta ${config.port} continua ocupada — o servidor pode não subir`)
    }
  }

  const server = await startServer(overrides)

  console.log(`griver ${SERVER_VERSION} ouvindo em ${server.url}`)
  console.log(`  dados:    ${server.config.dataDir}`)
  console.log(`  token:    ${server.config.token}`)
  console.log(`  extensão: ws://${server.config.host}:${server.config.port}/ws`)
  console.log("")
  console.log("Cole o token no painel da extensão para conectar.")
  console.log(`Carregue a extensão de: ${extensionPath()}`)

  if (server.orphanedRuns > 0) {
    console.log(
      `execuções que ficaram pendentes no servidor anterior foram encerradas: ${server.orphanedRuns}`,
    )
  }

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} — encerrando...`)
    await server.close()
    process.exit(0)
  }

  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))

  // quem started o servidor vai junto quando ele morre
  vigiaGuardiao(guardiao, () => void shutdown("o processo que started o servidor morreu"))

  // o caso detached: o guardião é a própria cadeia do servidor, então a
  // vigia de verdade é sobre quem criou a sessão
  vigiaGuardiao(criador, () => void shutdown("quem started a sessão do servidor morreu"))

  return server
}

/**
 * Acha quem é o dono da sessão do processo: o líder da sessão.
 *
 * A cadeia de quem started um servidor tem várias camadas: `pnpm` → `tsx` →
 * o processo do Node. Vigiar o pai direto não resolve — quando o shell
 * morre, essa cadeia inteira continua viva e o pai direto nem percebe.
 *
 * O líder da sessão é quem manda na sessão: normalmente o shell que pediu o
 * servidor. Quando ele morre, o servidor fica sozinho — órfão, segurando a
 * porta e a memória sem ninguém para falar com ele.
 *
 * É a mesma regra do limpador (`griver cleanup`): um servidor é órfão
 * quando o líder da sua sessão morreu.
 *
 * Devolve `undefined` quando não há ninguém para vigiar: quem é o próprio
 * líder (o servidor foi detached de propósito) ou quem nasceu sem sessão.
 */
export function guardiaoDaCadeia(): number | undefined {
  const sessao = sessaoDe(process.pid)

  // sou o líder da minha sessão: ninguém pode me derrubar por aqui
  if (sessao === undefined || sessao === process.pid) return undefined

  return sessao
}

/** Sessão (o terminal) de um pid, lida de `/proc` (Linux). */
function sessaoDe(pid: number): number | undefined {
  try {
    // depois do ')' vem: estado, ppid, pgrp, session
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const campos = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)
    const sessao = Number(campos[3])
    return Number.isFinite(sessao) ? sessao : undefined
  } catch {
    return undefined
  }
}

/**
 * Variável de ambiente com o pid de quem started o servidor.
 *
 * O kernel não guarda de quem um processo órfão era filho: quando o pai
 * morre, o filho é reparentado para o init e o nome se perde. Ler o
 * `/proc` depois já não acha ninguém — e quem died na largada (um script
 * que sobe o servidor e sai) nunca é encontrado.
 *
 * Quem started o servidor passa o pid por herança: o filho sabe de
 * primeira mão quem o criou, sem depender do `/proc` e sem perder a
 * corrida.
 *
 * ```sh
 * GRIVER_CRIADOR=$$ setsid griver serve &
 * ```
 */
export const VAR_CRIADOR = "GRIVER_CRIADOR"

/**
 * Acha quem started a sessão do servidor: o pai do líder da sessão.
 *
 * O guardião de sempre não resolve o caso detached: quando o servidor é
 * detached (`setsid`), o líder da sessão é o `pnpm` da própria cadeia do
 * servidor. Esse só morre junto com o servidor — a vigia nunca dispara e o
 * servidor sobrevive a quem o started, segurando a porta e a memória.
 *
 * Quem de fato pode morrer antes é quem criou a sessão: o pai do líder. Ele
 * só conta quando veio de outra sessão, porque foi o `setsid` que separou os
 * dois. No caso comum — o shell e o servidor na mesma sessão — ninguém se
 * separou, e a vigia do líder já dá conta.
 *
 * O pid que veio por herança tem a primeira palavra: ele foi passado por
 * quem ainda estava vivo, e por isso não depende de o `/proc` lembrar de
 * alguém que já saiu.
 */
export function criadorDaSessao(): number | undefined {
  // quem started o servidor disse quem era, por herança
  const herdado = Number(process.env[VAR_CRIADOR])
  if (Number.isInteger(herdado) && herdado > 1) return herdado

  const lider = sessaoDe(process.pid)
  if (lider === undefined) return undefined

  const processoLider = lerProcesso(lider)
  if (!processoLider) return undefined

  const criador = lerProcesso(processoLider.ppid)
  // o init é o ambiente (contêiner, systemd): não há ninguém para vigiar
  if (!criador || criador.pid <= 1) return undefined
  // mesma sessão: ninguém se separou do servidor
  if (criador.sessao === processoLider.sessao) return undefined

  return criador.pid
}

/**
 * Encerra o servidor quando o guardião morre.
 *
 * Um servidor que sobrevive a quem o started vira órfão: segura a porta e
 * a memória sem ninguém para falar com ele. Numa máquina de desenvolvimento,
 * alguns servidores órfãos chegam a ocupar gigabytes de RAM.
 *
 * @param guardiao pid que precisa continuar vivo; `undefined` desliga a vigia
 * @param aoMorrer called when the guardian is gone
 * @param opcoes interval and liveness check — overridden in tests
 */
export function vigiaGuardiao(
  guardiao: number | undefined,
  aoMorrer: () => void,
  opcoes: { intervaloMs?: number; vivo?: (pid: number) => boolean } = {},
): NodeJS.Timeout {
  const { intervaloMs = 2000, vivo = processoVivo } = opcoes

  // ninguém para vigiar: o guardião é o ambiente (contêiner, systemd)
  if (guardiao === undefined) {
    const ocioso = setInterval(() => {}, 60_000)
    ocioso.unref?.()
    return ocioso
  }

  const timer = setInterval(() => {
    if (vivo(guardiao)) return
    clearInterval(timer)
    aoMorrer()
  }, intervaloMs)

  // a vigia não pode ser a razão de o processo continuar vivo
  timer.unref?.()
  return timer
}

/** Diz se o processo ainda existe de verdade. */
function processoVivo(pid: number): boolean {
  try {
    // o estado vem antes do ppid em /proc/<pid>/stat: 'Z' é zumbi
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const campos = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)
    // 'Z' é zumbi: o processo já morreu, só não foi colhido ainda
    if (campos[0] === "Z") return false
    return true
  } catch {
    // sem /proc: pergunta ao kernel
    try {
      // o sinal 0 não entrega nada: só pergunta se o processo existe
      process.kill(pid, 0)
      return true
    } catch (error) {
      // EPERM é "existe, mas é de outro usuário"
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }
}

/** Caminho da extensão empacotada, relativo a este arquivo. */
export function extensionPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // src/ → dist/ → packages/server/ → packages/ → extension/dist
  return resolve(here, "../../extension/dist")
}
