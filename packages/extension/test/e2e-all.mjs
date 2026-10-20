/**
 * Roda toda a suíte end-to-end da extensão em sequência.
 *
 * Cada teste abre um Chrome próprio; sem uma pausa entre eles, os processos
 * se acumulam e a máquina fica sem memória. Este script cuida da limpeza.
 *
 * Uso: node packages/extension/test/e2e-all.mjs [serverUrl]
 */
import { spawn, execSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { criarSiteTeste } from "./site.mjs"

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

const TESTES = [
  "verifica-painel",
  "overlay",
  "modal",
  "panel-save",
  "uso-real",
  "erro-gravacao",
  // permissão de host: base da gravação por extensão e da execução na aba
  "inject-host",
  "navegar-host",
]

/** Tempo máximo de um teste antes de ser considerado travado. */
const TEMPO_MAXIMO_MS = 180_000

/**
 * Fecha os Chromes que sobraram de uma execução anterior.
 *
 * Só mata navegador que ninguém mais está usando: um Chrome cujo processo
 * pai já morreu virou órfão e vai segurar memória à toa. Quem ainda tem
 * pai vivo pertence a outra execução — essa fica intacta.
 *
 * Antes isso matava qualquer Chrome com `/griver-` no comando, o que
 * derrubava o navegador das execuções paralelas na mesma máquina.
 */
function limparChrome() {
  let lista
  try {
    lista = execSync("ps -eo pid,ppid,args --no-headers", { encoding: "utf8" })
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
    const [pid, ppid] = linha.split(/\s+/).slice(0, 2).map(Number)
    if (!pid || !ppid) continue
    if (pid === process.pid) continue

    // perfil desta execução: sempre nosso, pode matar
    // perfil de outra execução: só mata se o pai morreu (órfão)
    const nosso = linha.includes(perfilBase)
    if (!nosso && ppid !== 1) continue

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

let falhou = false

const servidor = servidorInformado ? null : await subirServidor()
const serverUrl = servidorInformado ?? servidor.url

// a página de teste é criada aqui: nenhum teste depende de um arquivo solto
// em /tmp, que sumiria na primeira limpeza da máquina
const site = criarSiteTeste()

for (const nome of TESTES) {
  limparChrome()
  await new Promise((r) => setTimeout(r, 500))

  const caminho = resolve(`packages/extension/test/${nome}.e2e.mjs`)
  const codigo = await new Promise((resolveCode) => {
    // o terceiro argumento é a página de teste: quem não usa, ignora
    const proc = spawn(process.execPath, [caminho, serverUrl, site.url], {
      stdio: "inherit",
      detached: true,
      env: { ...process.env, TMPDIR: perfilBase },
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

site.limpar()

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
  //Profiles temporários podem ficar para trás; não é motivo para falhar.
}

if (falhou) {
  console.log("✗ algum teste falhou")
  process.exit(1)
}
console.log("✓ todos os testes passaram")
