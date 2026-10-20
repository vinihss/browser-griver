import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { startServer, SERVER_VERSION, type GriverServer } from "./index.js"
import { encerrarOrfaos, estaVivo, leitorDoSistema } from "./orfaos.js"
import type { ServerConfig } from "./config.js"

/**
 * Espera os servidores encerrarem soltarem a porta.
 *
 * O SIGTERM é um pedido: o servidor fecha o banco e devolve a porta. Sem
 * esperar, o servidor novo bate numa porta ainda ocupada.
 */
async function esperarLiberacao(pids: number[], timeoutMs = 3000): Promise<void> {
  const fim = Date.now() + timeoutMs
  while (Date.now() < fim) {
    const vivos = pids.filter((pid) => estaVivo(leitorDoSistema.info(pid)))
    if (vivos.length === 0) return
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

  // servidor que sobrou de uma execução anterior: o shell que o started
  // morreu e ele ficou de pé, segurando a porta e a memória. Antes de
  // pegar a porta, ele sai da frente.
  const orfaos = await encerrarOrfaos()
  if (orfaos.length > 0) {
    console.log(`servidores órfãos encerrados: ${orfaos.map((orfao) => orfao.pid).join(", ")}`)
    await esperarLiberacao(orfaos.map((orfao) => orfao.pid))
  }

  const server = await startServer(overrides)

  console.log(`griver ${SERVER_VERSION} ouvindo em ${server.url}`)
  console.log(`  dados:    ${server.config.dataDir}`)
  console.log(`  token:    ${server.config.token}`)
  console.log(`  extensão: ws://${server.config.host}:${server.config.port}/ws`)
  console.log("")
  console.log("Cole o token no painel da extensão para conectar.")
  console.log(`Carregue a extensão de: ${extensionPath()}`)

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} — encerrando...`)
    await server.close()
    process.exit(0)
  }

  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))

  // quem started o servidor vai junto quando ele morre
  vigiaGuardiao(guardiao, () => void shutdown("o processo que started o servidor morreu"))

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
