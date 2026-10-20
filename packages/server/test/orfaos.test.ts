import { test } from "node:test"
import assert from "node:assert/strict"
import {
  eServidorDoGriver,
  encerrarOrfaos,
  servidoresOrfaos,
  type Leitor,
  type ProcessoInfo,
} from "../src/orfaos.js"

/** Monta um processo de mentira. */
function processo(campos: Partial<ProcessoInfo> & { pid: number }): ProcessoInfo {
  return {
    ppid: 1,
    grupo: campos.pid,
    sessao: campos.pid,
    estado: "S",
    cmdline: "",
    cwd: "",
    ...campos,
  }
}

/** Leitor de mentira: tudo que o teste descrever. */
function leitorDe(processos: ProcessoInfo[]): Leitor {
  return {
    info: (pid) => processos.find((p) => p.pid === pid),
    listar: () => processos,
  }
}

test("reconhece o servidor do Griver pelo código ou pelo diretório", () => {
  const peloCodigo = processo({
    pid: 10,
    cmdline: "node /home/linha/browser-griver/packages/server/dist/main.js",
  })
  assert.equal(eServidorDoGriver(peloCodigo), true)

  const peloDiretorio = processo({
    pid: 11,
    cmdline: "node --require tsx/preflight.cjs src/main.ts",
    cwd: "/home/linha/browser-griver/packages/server",
  })
  assert.equal(eServidorDoGriver(peloDiretorio), true)

  const outroPrograma = processo({
    pid: 12,
    cmdline: "node /home/linha/outro-coisa/src/main.ts",
    cwd: "/home/linha/outro-coisa",
  })
  assert.equal(eServidorDoGriver(outroPrograma), false)

  const naoServidor = processo({
    pid: 13,
    cmdline: "node /home/linha/browser-griver/packages/server/dist/other.js",
    cwd: "/home/linha/browser-griver/packages/server",
  })
  assert.equal(eServidorDoGriver(naoServidor), false)
})

test("um servidor com dono vivo não é órfão", () => {
  const processos = [
    // o shell da sessão (líder) está vivo
    processo({ pid: 100, cmdline: "zsh -c start-all.sh" }),
    processo({
      pid: 101,
      ppid: 100,
      sessao: 100,
      cmdline: "node packages/server/src/main.ts",
      cwd: "/repo/packages/server",
    }),
  ]
  const orfaos = servidoresOrfaos(leitorDe(processos))
  assert.deepEqual(
    orfaos.map((p) => p.pid),
    [],
    "servidor com dono vivo não pode ser listado como órfão",
  )
})

test("um servidor sem dono é órfão", () => {
  const processos = [
    // o líder da sessão morreu: sobrou só o servidor
    processo({
      pid: 200,
      ppid: 2,
      sessao: 199,
      cmdline: "node packages/server/src/main.ts",
      cwd: "/repo/packages/server",
    }),
  ]
  const orfaos = servidoresOrfaos(leitorDe(processos))
  assert.deepEqual(
    orfaos.map((p) => p.pid),
    [200],
    "servidor sem dono tem de ser listado como órfão",
  )
})

test("um servidor cujo criador morreu é órfão", () => {
  // o servidor foi detached (setsid) e o shell que o started morreu:
  // o init herdou o processo, que ficou sozinho na máquina
  const processos = [
    processo({
      pid: 250,
      ppid: 1,
      sessao: 250,
      grupo: 250,
      cmdline: "node packages/server/src/main.ts",
      cwd: "/repo/packages/server",
    }),
  ]
  const orfaos = servidoresOrfaos(leitorDe(processos))
  assert.deepEqual(
    orfaos.map((p) => p.pid),
    [250],
    "criador morto é órfão mesmo quando o servidor é o líder da sessão",
  )
})

test("um zumbi não conta como dono", () => {
  const processos = [
    // o líder da sessão morreu, mas o processo ainda não foi recolhido
    processo({ pid: 300, estado: "Z", cmdline: "zsh -c start-all.sh" }),
    processo({
      pid: 301,
      ppid: 300,
      sessao: 300,
      cmdline: "node packages/server/src/main.ts",
      cwd: "/repo/packages/server",
    }),
  ]
  const orfaos = servidoresOrfaos(leitorDe(processos))
  assert.deepEqual(
    orfaos.map((p) => p.pid),
    [301],
    "zumbi é processo morto: não é dono de ninguém",
  )
})

test("quem é o líder da própria sessão não é órfão", () => {
  const processos = [
    // servidor detached de propósito (setsid): ele é o líder e o criador
    // (o shell) ainda está vivo
    processo({
      pid: 400,
      ppid: 2,
      sessao: 400,
      grupo: 400,
      cmdline: "node packages/server/src/main.ts",
      cwd: "/repo/packages/server",
    }),
  ]
  const orfaos = servidoresOrfaos(leitorDe(processos))
  assert.deepEqual(
    orfaos.map((p) => p.pid),
    [],
    "o líder da própria sessão sobrevive sozinho",
  )
})

test("só a raiz da cadeia é reapeada", () => {
  // pnpm → tsx → node: um servidor só, três processos
  const processos = [
    processo({
      pid: 600,
      ppid: 1,
      sessao: 600,
      grupo: 600,
      cmdline: "pnpm exec tsx src/main.ts",
      cwd: "/repo/packages/server",
    }),
    processo({
      pid: 601,
      ppid: 600,
      sessao: 600,
      grupo: 600,
      cmdline: "node node_modules/.bin/tsx src/main.ts",
      cwd: "/repo/packages/server",
    }),
    processo({
      pid: 602,
      ppid: 601,
      sessao: 600,
      grupo: 600,
      cmdline: "node --require tsx/preflight.cjs src/main.ts",
      cwd: "/repo/packages/server",
    }),
  ]
  const orfaos = servidoresOrfaos(leitorDe(processos))
  assert.deepEqual(
    orfaos.map((p) => p.pid),
    [600],
    "a cadeia é um servidor só: derrubar a raiz derruba o resto",
  )
})

test("encerrarOrfaos mata só os órfãos", () => {
  const processos = [
    processo({ pid: 500, cmdline: "zsh -c start-all.sh" }),
    processo({
      pid: 501,
      ppid: 500,
      sessao: 500,
      cmdline: "node packages/server/src/main.ts",
      cwd: "/repo/packages/server",
    }),
    processo({
      pid: 502,
      sessao: 499,
      cmdline: "node packages/server/src/main.ts",
      cwd: "/repo/packages/server",
    }),
  ]

  const mortos: number[] = []
  const orfaos = encerrarOrfaos(leitorDe(processos), (alvo) => {
    mortos.push(alvo)
  })

  assert.deepEqual(orphans(orfaos), [502])
  // alvo negativo é o grupo: o pnpm, o tsx e o node caem juntos
  assert.deepEqual(mortos, [-502], "só o órfão pode ser morto, e o grupo inteiro vai junto")
})

test("o grupo cai junto com a raiz", () => {
  const processos = [
    processo({
      pid: 700,
      ppid: 1,
      sessao: 700,
      grupo: 700,
      cmdline: "pnpm exec tsx src/main.ts",
      cwd: "/repo/packages/server",
    }),
  ]

  const mortos: number[] = []
  encerrarOrfaos(leitorDe(processos), (alvo) => {
    mortos.push(alvo)
  })

  assert.deepEqual(mortos, [-700], "derrubar a raiz é derrubar o grupo")
})

test("o servidor não derruba a si mesmo", () => {
  // eu sou o servidor: o meu processo está na lista e o meu criador morreu
  const eu = processo({
    pid: process.pid,
    ppid: 1,
    sessao: process.pid,
    grupo: process.pid,
    cmdline: "node packages/server/src/main.ts",
    cwd: "/repo/packages/server",
  })

  const mortos: number[] = []
  const orfaos = encerrarOrfaos(leitorDe([eu]), (alvo) => {
    mortos.push(alvo)
  })

  assert.deepEqual(orphans(orfaos), [], "o servidor não é órfão de si mesmo")
  assert.deepEqual(mortos, [], "a limpeza não pode derrubar quem está limpando")
})

/** Atalho para os pids de uma lista. */
function orphans(lista: ProcessoInfo[]): number[] {
  return lista.map((p) => p.pid)
}
