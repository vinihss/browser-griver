/**
 * Roda toda a suíte end-to-end da extensão em sequência.
 *
 * Cada teste abre um Chrome próprio; sem uma pausa entre eles, os processos
 * se acumulam e a máquina fica sem memória. Este script cuida da limpeza.
 *
 * Uso: node packages/extension/test/e2e-all.mjs [serverUrl]
 */
import { spawn, execSync } from "node:child_process"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { criarSiteTeste } from "./site.mjs"
import { exigeDisplay } from "./helpers.mjs"

// sem tela, cada um dos nove testes morre na largada com o mesmo erro
// confuso: melhor avisar uma vez, com a causa e o conserto
exigeDisplay()

/**
 * Endereço do servidor usado pelos testes.
 *
 * Sem argumento, a suíte sobe o próprio servidor (porta e banco próprios).
 * Com argumento, usa o servidor indicado.
 */
const servidorInformado = process.argv[2]

/**
 * Diretório de perfis só desta execução.
 *
 * Os testes criam o perfil do Chrome em `os.tmpdir()`, que respeita o
 * `TMPDIR`. Dar um diretório exclusivo por execução impede que duas suítes
 * rodando ao mesmo tempo usem o mesmo perfil.
 */
const perfilBase = mkdtempSync(join(tmpdir(), "griver-suite-"))

/**
 * Tempo sem uso do perfil para o navegador ser considerado resíduo.
 *
 * Dois minutos: tempo de sobra para um teste em andamento mexer no perfil,
 * e curto o bastante para não deixar resíduo accumulando.
 */
const PERFIL_PARADO_MS = 120_000

const TESTES = [
  "verifica-painel",
  "overlay",
  "modal",
  "panel-save",
  "uso-real",
  "erro-gravacao",
  // o painel tem que usar o token do servidor que ele aponta
  "token-servidor",
  // permissão de host: base da gravação por extensão e da execução na aba
  "inject-host",
  "navegar-host",
]

/** Tempo máximo de um teste antes de ser considerado travado. */
const TEMPO_MAXIMO_MS = 180_000

/**
 * O que esta execução montou e tem que derrubar ao sair.
 *
 * Vive no topo do arquivo porque a limpeza roda por sinal: quando a suíte
 * morre no meio, quem limpa precisa saber o que existia — e não pode tropeçar
 * numa variável que ainda não foi declarada.
 */
let servidor = null
let site = null
let extensionPath = null

/**
 * Encerra servidores do Griver que ficaram órfãos.
 *
 * Uma execução anterior morta no meio deixa o servidor de pé: ele segura a
 * porta e a memória sem ninguém para falar com ele. O limpador do CLI
 * (`griver cleanup`) sabe quais não têm dono — os que têm dono vivo, de
 * outra execução rodando ao mesmo tempo, ficam intactos.
 */
function limparServidores() {
  try {
    execSync("pnpm exec tsx packages/cli/src/index.ts cleanup", {
      cwd: resolve("."),
      stdio: "ignore",
    })
  } catch {
    // sem limpador, a suíte segue: o servidor órfão só ocupa memória
  }
}

/**
 * Limpa tudo que esta execução deixou para trás.
 *
 * A suíte é morta por sinal com frequência: Ctrl+C, o `timeout` do CI, o
 * terminal fechando. O servidor isolado é detached de propósito — sem esta
 * limpeza ele sobrevive à suíte morta e fica segurando a porta e a memória
 * de uma execução que já acabou.
 */
function limpar() {
  try {
    site?.limpar()
  } catch {
    // o site já foi limpo
  }

  // derruba o servidor isolado antes de sair: ele fica esperando conexões
  if (servidor) {
    matarGrupo(servidor.proc)
    try {
      rmSync(servidor.dadosDir, { recursive: true, force: true })
    } catch {
      // o banco temporário pode ficar para trás; não é motivo para falhar
    }
  }

  try {
    rmSync(perfilBase, { recursive: true, force: true })
  } catch {
    // perfis temporários podem ficar para trás; não é motivo para falhar
  }

  // a cópia da extensão é nossa: some junto com a suíte
  if (extensionPath && !process.env.GRIVER_EXTENSION_PATH) {
    try {
      rmSync(extensionPath, { recursive: true, force: true })
    } catch {
      // a pasta temporária pode ficar para trás; não é motivo para falhar
    }
  }
}

// o sinal chega a qualquer momento: registrar aqui garante que a limpeza
// existe mesmo quando a suíte morre no meio da subida do servidor
for (const sinal of ["SIGINT", "SIGTERM"]) {
  process.on(sinal, () => {
    console.log(`\n${sinal} — limpando antes de sair...`)
    limpar()
    console.log(`limpeza feita (servidor: ${servidor ? servidor.proc.pid : "nenhum"})`)
    // o código de saída do shell: 130 é Ctrl+C, 143 é TERM
    process.exit(sinal === "SIGINT" ? 130 : 143)
  })
}

/**
 * Fecha os Chromes que sobraram de uma execução anterior.
 *
 * O critério é o perfil: um diretório que não é mexido há mais de dois
 * minutos pertence a um navegador que ninguém está usando — pode ser morto.
 * Perfil mexido é teste em andamento, de outra execução ou desta, e fica
 * intacto.
 *
 * O antigo critério (matar quando o processo pai morreu) derrubava o
 * navegador de execuções paralelas: o crashpad handler do Chrome é
 * daemonizado, então o pai dele é o init e todo crashpad handler parecia
 * órfão — inclusive o de um Chrome que estava rodando.
 */
function limparChrome() {
  let lista
  try {
    lista = execSync("ps -eo pid,args --no-headers", { encoding: "utf8" })
      .split("\n")
      .map((linha) => linha.trim())
      .filter(Boolean)
      .filter((linha) => /chrom/.test(linha))
      .filter((linha) => /--user-data-dir=\S*griver-/.test(linha))
  } catch {
    return 0
  }

  let mortos = 0
  for (const linha of lista) {
    const pid = Number(linha.split(/\s+/)[0])
    if (!pid || pid === process.pid) continue

    const perfil = linha.match(/--user-data-dir=(\S*griver-[^\s]*)/)?.[1]
    if (!perfil) continue

    // perfil desta execução: sempre nosso, pode matar
    if (perfil.includes(perfilBase)) {
      // segue para o kill
    } else {
      // perfil de outra execução: só mata se estiver parado há tempo
      try {
        const mexido = statSync(perfil).mtimeMs
        if (Date.now() - mexido < PERFIL_PARADO_MS) continue
      } catch {
        // perfil já sumiu: o processo está saindo, não precisa de kill
        continue
      }
    }

    try {
      // mata o grupo inteiro: o navegador e os filhos dele
      execSync(`kill -9 -- -${pid} 2>/dev/null || kill -9 ${pid} 2>/dev/null`, {
        stdio: "ignore",
      })
      mortos++
    } catch {
      // já morreu
    }
  }
  return mortos
}

/**
 * Mata o processo do teste e o Chrome que ele abriu.
 *
 * O teste roda em seu próprio grupo de processos (`detached`), então o grupo
 * inteiro cai junto — inclusive o Chrome órfão que o teste deixou.
 */
function matarGrupo(proc) {
  if (!proc.pid) return
  try {
    process.kill(-proc.pid, "SIGKILL")
  } catch {
    try {
      process.kill(proc.pid, "SIGKILL")
    } catch {
      // já morreu
    }
  }
}

/**
 * Reserva uma porta livre para o servidor da suíte.
 *
 * Deixa o sistema escolher evita cair na porta de outra execução: duas
 * suítes em paralelo não podem compartilhar servidor nem banco.
 */
function portaLivre() {
  return new Promise((resolvePorta, reject) => {
    const sonda = createServer()
    sonda.unref()
    sonda.on("error", reject)
    sonda.listen(0, "127.0.0.1", () => {
      const endereco = sonda.address()
      const porta = typeof endereco === "object" && endereco ? endereco.port : 0
      sonda.close(() => resolvePorta(porta))
    })
  })
}

/**
 * Cria um projeto e uma receita no servidor.
 *
 * O painel só mostra a seção de Receitas quando existe alguma receita
 * salva: sem a semente, o teste do painel reprova por falta de conteúdo.
 */
async function semear(url) {
  // o token protege as rotas de escrita: sem ele o servidor devolve 401
  const { token } = await fetch(`${url}/api/extension-token`).then((r) => r.json())
  const headers = { "content-type": "application/json", "x-griver-token": token }

  const projeto = await fetch(`${url}/api/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Teste uso" }),
  }).then((r) => r.json())

  await fetch(`${url}/api/recipes`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      projectId: projeto.project.id,
      name: "Fluxo",
      target: "browser",
      recipe: { version: 1, steps: [] },
    }),
  })
}

/**
 * Sobe um servidor isolado para a suíte.
 *
 * Servidor próprio por execução: o roteamento de comandos do servidor entrega
 * a requisição à primeira extensão conectada, e suítes rodando em paralelo
 * contra o mesmo servidor passam o `navigate` de uma para a aba de outra — o
 * teste morre com "Execution context was destroyed".
 */
async function subirServidor() {
  const porta = await portaLivre()
  const url = `http://127.0.0.1:${porta}`
  const dadosDir = mkdtempSync(join(tmpdir(), "griver-suite-dados-"))

  const proc = spawn("pnpm", ["exec", "tsx", "src/main.ts"], {
    cwd: resolve("packages/server"),
    env: { ...process.env, GRIVER_PORT: String(porta), GRIVER_DATA_DIR: dadosDir },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })

  let saida = ""
  proc.stdout?.on("data", (d) => {
    saida += d.toString()
  })
  proc.stderr?.on("data", (d) => {
    saida += d.toString()
  })

  // espera o servidor responder
  let pronto = false
  for (let tentativa = 0; tentativa < 60 && !pronto; tentativa++) {
    try {
      const resposta = await fetch(`${url}/api/health`)
      pronto = resposta.ok
    } catch {
      // ainda subindo
    }
    if (!pronto) await new Promise((r) => setTimeout(r, 500))
  }

  if (!pronto) {
    matarGrupo(proc)
    throw new Error(`servidor não subiu na porta ${porta}\n${saida}`)
  }

  // a semente fica fora do laço: um erro aqui precisa aparecer, senão a
  // falha real se esconde atrás de "não subiu"
  await semear(url)
  console.log(`servidor isolado: ${url}\n`)
  return { url, proc, dadosDir }
}

/**
 * Constrói uma cópia particular da extensão para esta execução.
 *
 * O `dist` compartilhado é apagado no começo de cada build: um teste que está
 * rodando com a extensão carregada perde os arquivos no meio do caminho e o
 * painel deixa de abrir (`ERR_FILE_NOT_FOUND`). A cópia resolve — cada
 * execução constrói a sua e ninguém atrapalha ninguém.
 *
 * Se `GRIVER_EXTENSION_PATH` vier de fora, ela manda: quem já tem uma cópia
 * pronta não quer esperar outro build.
 */
async function construirExtensao() {
  const informada = process.env.GRIVER_EXTENSION_PATH
  if (informada) return informada

  const pasta = mkdtempSync(join(tmpdir(), "griver-ext-"))
  const caminho = resolve("packages/extension/build.mjs")

  const codigo = await new Promise((resolveCodigo) => {
    const proc = spawn(process.execPath, [caminho, "--outdir", pasta], {
      stdio: "inherit",
    })
    proc.on("exit", (code) => resolveCodigo(code ?? 1))
  })

  if (codigo !== 0) throw new Error("a extensão não foi construída")
  return pasta
}

let falhou = false

servidor = servidorInformado ? null : await subirServidor()
const serverUrl = servidorInformado ?? servidor.url

extensionPath = await construirExtensao()

// a página de teste é criada aqui: nenhum teste depende de um arquivo solto
// em /tmp, que sumiria na primeira limpeza da máquina
site = criarSiteTeste()

for (const nome of TESTES) {
  limparChrome()
  limparServidores()
  await new Promise((r) => setTimeout(r, 500))

  const caminho = resolve(`packages/extension/test/${nome}.e2e.mjs`)
  const codigo = await new Promise((resolveCode) => {
    // o terceiro argumento é a página de teste: quem não usa, ignora
    const proc = spawn(process.execPath, [caminho, serverUrl, site.url], {
      stdio: "inherit",
      detached: true,
      env: { ...process.env, TMPDIR: perfilBase, GRIVER_EXTENSION_PATH: extensionPath },
    })

    // um teste travado segura o Chrome e o grupo de processos para sempre
    const timer = setTimeout(() => {
      console.log(`  (tempo esgotado: ${nome})`)
      matarGrupo(proc)
    }, TEMPO_MAXIMO_MS)

    proc.on("exit", (code) => {
      clearTimeout(timer)
      resolveCode(code ?? 1)
    })
  })

  if (codigo === 0) {
    console.log(`✓ ${nome}\n`)
  } else {
    console.log(`✗ ${nome} (código ${codigo})\n`)
    falhou = true
  }
}

limparChrome()
limparServidores()
limpar()

if (falhou) {
  console.log("✗ algum teste falhou")
  process.exit(1)
}
console.log("✓ todos os testes passaram")
