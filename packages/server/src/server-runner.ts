import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { startServer, SERVER_VERSION, type GriverServer } from "./index.js"
import type { ServerConfig } from "./config.js"

/**
 * Sobe o servidor e mantém o processo vivo.
 *
 * Usado tanto pelo binário `griver-server` quanto por `griver serve`, para
 * que os dois imprimam a mesma orientação.
 */
export async function runServer(overrides: Partial<ServerConfig> = {}): Promise<GriverServer> {
  const guardiao = guardiaoDaCadeia()
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
 * Acha quem é o dono da sessão do processo: o líder do seu grupo.
 *
 * A cadeia de quem started um servidor tem várias camadas: `pnpm` → `tsx` →
 * o processo do Node. Vigiar o pai direto não resolve — quando o shell
 * morre, essa cadeia inteira continua viva e o pai direto nem percebe.
 *
 * O líder do grupo é quem manda na sessão: normalmente o shell que pediu o
 * servidor. Quando ele morre, o servidor fica sozinho na sessão — órfão,
 * segurando a porta e a memória sem ninguém para falar com ele.
 *
 * Devolve `undefined` quando não há ninguém para vigiar: quem é o próprio
 * líder (o servidor foi detached de propósito) ou quem nasceu sem grupo.
 */
export function guardiaoDaCadeia(): number | undefined {
  const grupo = grupoDe(process.pid)

  // sou o líder do meu grupo: ninguém pode derrubar o grupo por aqui
  if (grupo === undefined || grupo === process.pid) return undefined

  return grupo
}

/** Grupo de processos de um pid, lido de `/proc` (Linux). */
function grupoDe(pid: number): number | undefined {
  try {
    // depois do ')' vem: estado, ppid, pgrp, session
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const campos = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)
    const grupo = Number(campos[2])
    return Number.isFinite(grupo) ? grupo : undefined
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
