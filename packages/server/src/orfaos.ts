/**
 * Achar e encerrar servidores do Griver que ficaram órfãos.
 *
 * Um servidor órfão é aquele que sobreviveu a quem o started: o shell
 * terminou, o processo ficou sozinho segurando a porta e a memória. Numa
 * máquina de desenvolvimento alguns desses chegam a ocupar gigabytes de RAM
 * e a brigar pela mesma porta.
 *
 * O sinal é o líder da sessão. A sessão é a sessão do terminal: quem a criou
 * é o shell, e é ele que deveria derrubar o servidor. Quando o líder da
 * sessão morre, o servidor fica sozinho — órfão. Quando o líder vive, o
 * servidor tem dono e ninguém mexe nele.
 */
import { readdirSync, readFileSync, readlinkSync } from "node:fs"

export interface ProcessoInfo {
  pid: number
  /** pai direto */
  ppid: number
  /** grupo de processos */
  grupo: number
  /** sessão (o terminal) à qual o processo pertence */
  sessao: number
  /** 'R', 'S', 'Z'... */
  estado: string
  /** linha de comando inteira */
  cmdline: string
  /** diretório de trabalho */
  cwd: string
  /** caminho no cgroup do sistema (vazio quando não dá para ler) */
  cgroup: string
}

/** Leitor de processos — injetável para o teste não depender do sistema. */
export interface Leitor {
  info(pid: number): ProcessoInfo | undefined
  listar(): ProcessoInfo[]
}

/** Lê um processo de `/proc`. */
export function lerProcesso(pid: number): ProcessoInfo | undefined {
  let stat: string
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8")
  } catch {
    return undefined
  }

  // depois do ')' vem: estado, ppid, pgrp, session...
  const campos = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)
  const estado = campos[0] ?? ""
  const ppid = Number(campos[1])
  const grupo = Number(campos[2])
  const sessao = Number(campos[3])
  if (!Number.isFinite(ppid) || !Number.isFinite(grupo) || !Number.isFinite(sessao)) {
    return undefined
  }

  let cmdline = ""
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ")
  } catch {
    // processo sem linha de comando (zumbi): segue com o que tem
  }

  let cwd = ""
  try {
    cwd = readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    // sem permissão ou já morto
  }

  let cgroup = ""
  try {
    cgroup = readFileSync(`/proc/${pid}/cgroup`, "utf8")
  } catch {
    // sem cgroup: fora do systemd, ou o processo já morreu
  }

  return { pid, ppid, grupo, sessao, estado, cmdline, cwd, cgroup }
}

/** Leitor de verdade, sobre o `/proc` do sistema. */
export const leitorDoSistema: Leitor = {
  info: lerProcesso,
  listar() {
    const processos: ProcessoInfo[] = []
    let pids: string[]
    try {
      pids = readdirSync("/proc")
    } catch {
      return processos
    }
    for (const entrada of pids) {
      if (!/^\d+$/.test(entrada)) continue
      const info = lerProcesso(Number(entrada))
      if (info) processos.push(info)
    }
    return processos
  },
}

/** Diz se o processo parece um servidor do Griver. */
export function eServidorDoGriver(processo: ProcessoInfo): boolean {
  if (!/main\.(ts|js)\b/.test(processo.cmdline)) return false
  // o servidor roda dentro do pacote do servidor, seja pelo código-fonte
  // (`src/main.ts`) ou pelo build (`dist/main.js`)
  return (
    /packages\/server\/(src|dist)\/main\.(ts|js)/.test(processo.cmdline) ||
    /packages\/server$/.test(processo.cwd)
  )
}

/** Diz se o processo está de pé (zumbi é processo morto esperando recolhimento). */
export function estaVivo(processo: ProcessoInfo | undefined): boolean {
  return processo !== undefined && processo.estado !== "Z"
}

/**
 * Diz se o processo tem dono no systemd.
 *
 * Um serviço do systemd (`griver-mcp.service`) roda com o pai no init:
 * o `ppid` é 1 mesmo com o servidor de pé e bem cuidinho. Sem esta
 * distinção, qualquer servidor novo que sobe — o da suíte de testes, o de
 * um `griver serve` no terminal — derrubaria o servidor de produção, e o
 * systemd o subiria de novo, derrubando a sessão de quem está trabalhando.
 *
 * O que denuncia o serviço é a última unidade do caminho no cgroup:
 * `/app.slice/griver-mcp.service`. As unidades acima (o `user@1000.service`
 * que segura a sessão inteira do usuário) não contam: um servidor ligado
 * no terminal do usuário também mora abaixo delas, e esse é justamente o
 * órfão que a limpeza tem de recolher. Um `scope` também não conta: ele
 * morre junto com o shell que o criou.
 */
export function temDonoNoServico(processo: ProcessoInfo): boolean {
  for (const linha of processo.cgroup.split("\n")) {
    // a linha é "hierarquia:controllers:caminho": o caminho é o que vem depois
    const caminho = linha.slice(linha.lastIndexOf(":") + 1)
    const unidade = caminho.slice(caminho.lastIndexOf("/") + 1)
    if (unidade.endsWith(".service")) return true
  }
  return false
}

/**
 * Diz se o processo ainda tem dono.
 *
 * O dono é quem o colocou no mundo: o shell que o started. Quando esse
 * criador morre, o processo é rebatizado pelo init — o pai vira 1 — e ele
 * fica sozinho, segurando a porta e a memória sem ninguém para falar com
 * ele.
 *
 * O líder da sessão é a segunda testemunha: quando o processo não é o líder,
 * a sessão inteira cai junto com o líder, e ninguém precisa adivinhar.
 */
export function temDonoVivo(processo: ProcessoInfo, leitor: Leitor = leitorDoSistema): boolean {
  // o criador morreu: o init herdou o processo e ele ficou órfão
  if (processo.ppid === 1) return temDonoNoServico(processo)

  // eu sou o líder: ninguém pode me derrubar por aqui
  if (processo.sessao === processo.pid) return true

  // o líder da sessão manda na sessão: se ele morreu, todos caíram
  return estaVivo(leitor.info(processo.sessao))
}

/** Lista os servidores do Griver que estão de pé. */
export function servidoresDoGriver(leitor: Leitor = leitorDoSistema): ProcessoInfo[] {
  return leitor.listar().filter((processo) => eServidorDoGriver(processo) && estaVivo(processo))
}

/**
 * As raízes das cadeias de servidores.
 *
 * Um servidor é uma cadeia: `pnpm` → `tsx` → o Node. Só a raiz é o processo
 * que alguém started — as outras herdaram o pai. Reapear a raiz derruba a
 * cadeia inteira, em vez de derrubar um elo e deixar os outros de pé.
 */
export function raizesDosServidores(leitor: Leitor = leitorDoSistema): ProcessoInfo[] {
  const servidores = servidoresDoGriver(leitor)
  const pids = new Set(servidores.map((servidor) => servidor.pid))
  return servidores.filter((servidor) => !pids.has(servidor.ppid))
}

/** Lista os servidores do Griver que ficaram órfãos. */
export function servidoresOrfaos(leitor: Leitor = leitorDoSistema): ProcessoInfo[] {
  return raizesDosServidores(leitor).filter((processo) => !temDonoVivo(processo, leitor))
}

/**
 * Os pids da minha própria cadeia: eu e quem me started.
 *
 * Um servidor nunca pode derrubar a si mesmo: se ele foi started por um
 * processo que já morreu, ele é órfão — mas o dono desse warrant é ele
 * mesmo, e a limpeza não pode derrubá-lo.
 */
export function minhaCadeia(leitor: Leitor = leitorDoSistema): number[] {
  const cadeia: number[] = []
  let atual = process.pid
  for (let i = 0; i < 32; i++) {
    const info = leitor.info(atual)
    if (!info) break
    cadeia.push(info.pid)
    if (info.ppid <= 1) break
    atual = info.ppid
  }
  return cadeia
}

/** Opções do encerramento dos órfãos. */
export interface EncerrarOpcoes {
  /** quanto tempo o órfão tem para sair depois do SIGTERM (ms) */
  esperaParaSigKillMs?: number
  /** diz se o processo continua de pé */
  vivo?: (pid: number) => boolean
}

/**
 * Encerra os servidores órfãos.
 *
 * O sinal é o mesmo do SIGTERM do shell: primeiro o pedido, e o SIGKILL só
 * se o processo não sair. O grupo vai junto — o servidor tem filhos (o
 * tsx, o pnpm) que precisam cair com ele, senão um dos filhos continua
 * segurando a porta.
 *
 * O SIGKILL não é exagero: um servidor preso no `close()` — esperando uma
 * conexão keep-alive que não vem — ignora o SIGTERM e continua segurando a
 * porta. A espera é o prazo do bom; depois dela, o processo é derrubado.
 *
 * @param matar recebe o alvo: negativo é o grupo inteiro, positivo é o pid
 */
export async function encerrarOrfaos(
  leitor: Leitor = leitorDoSistema,
  matar: (alvo: number, sinal: NodeJS.Signals) => void = (alvo, sinal) => {
    try {
      process.kill(alvo, sinal)
    } catch {
      // já morreu
    }
  },
  opcoes: EncerrarOpcoes = {},
): Promise<ProcessoInfo[]> {
  const { esperaParaSigKillMs = 3000, vivo = (pid: number) => estaVivo(leitor.info(pid)) } = opcoes

  const meus = new Set(minhaCadeia(leitor))
  const orfaos = servidoresOrfaos(leitor).filter((orfao) => !meus.has(orfao.pid))
  if (orfaos.length === 0) return orfaos

  // a cadeia é montada antes do sinal: depois do SIGTERM os órfãos são
  // reparentados pelo init e a lista de filhos se perde
  const planos = orfaos.map((orfao) => {
    const cadeia = [orfao.pid, ...descendentes(orfao.pid, leitor)]
    return { orfao, cadeia, alvos: alvosDoOrfao(orfao, cadeia) }
  })

  for (const plano of planos) {
    for (const alvo of plano.alvos) matar(alvo, "SIGTERM")
  }

  // o prazo do bom: enquanto a cadeia toda sair, não há por que esperar
  const limite = Date.now() + esperaParaSigKillMs
  while (Date.now() < limite) {
    if (planos.every((plano) => !plano.cadeia.some((pid) => vivo(pid)))) return orfaos
    await espera(50)
  }

  // quem ignorou o pedido continua segurando a porta: leva SIGKILL
  for (const plano of planos) {
    // o grupo só é derrubado se alguém da cadeia ainda está de pé
    const grupoVivo =
      plano.alvos.some((alvo) => alvo < 0) && plano.cadeia.some((pid) => vivo(pid))
    for (const alvo of plano.alvos) {
      if (alvo < 0) {
        if (grupoVivo) matar(alvo, "SIGKILL")
        continue
      }
      // sinal em pid morto pode acertar outro processo: só mata quem vive
      if (!vivo(alvo)) continue
      matar(alvo, "SIGKILL")
    }
  }
  return orfaos
}

/**
 * Os alvos do sinal: a cadeia inteira do órfão.
 *
 * A cadeia é `pnpm` → `tsx` → `node`, e quem segura a porta é o último: o
 * Node. Derrubar só a raiz deixa o Node de pé, com a porta presa — e o
 * servidor novo bate num EADDRINUSE que não passa.
 *
 * Quando o órfão lidera o próprio grupo, o grupo já é a cadeia: um sinal
 * negativo derruba tudo de uma vez. Quando o grupo é de outra pessoa (o
 * shell que started o servidor), o grupo não pode ser tocado — aí cada
 * elo da cadeia é sinalizado pelo seu pid.
 */
export function alvosDoOrfao(orfao: ProcessoInfo, cadeia: number[] = []): number[] {
  if (orfao.grupo === orfao.pid) return [-orfao.grupo]
  return [orfao.pid, ...cadeia.filter((pid) => pid !== orfao.pid)]
}

/**
 * Os processos que descendem de um pid: filhos, netos, bisnetos.
 *
 * É a cadeia do servidor: quem herda o pai herda também a porta.
 */
export function descendentes(pid: number, leitor: Leitor = leitorDoSistema): number[] {
  const filhos = new Map<number, number[]>()
  for (const processo of leitor.listar()) {
    const lista = filhos.get(processo.ppid) ?? []
    lista.push(processo.pid)
    filhos.set(processo.ppid, lista)
  }

  const achados: number[] = []
  const fila = [...(filhos.get(pid) ?? [])]
  while (fila.length > 0) {
    const atual = fila.shift()!
    achados.push(atual)
    fila.push(...(filhos.get(atual) ?? []))
  }
  return achados
}

/** Espera um tempo, em milissegundos. */
function espera(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
