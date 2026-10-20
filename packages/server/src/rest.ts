/**
 * Cliente REST do servidor do Griver.
 *
 * É o mesmo cliente que as ferramentas do MCP usam — extraído para um
 * lugar só, porque agora a linha de comando também conversa com o
 * servidor: uma operação precisa ter a mesma resposta e o mesmo erro nos
 * dois canais.
 *
 * O token é resolvido em cascata: o que vier do ambiente, depois o
 * arquivo `token` da pasta de dados e, por último, o próprio servidor
 * (`/api/extension-token`). Um 401 relê o token em vez de insistir com o
 * velho — o servidor pode ter sido reiniciado com outro token no meio do
 * caminho.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

/** Endereço do servidor quando nada é informado. */
export const SERVIDOR_PADRAO = "http://127.0.0.1:7331"

/** Endereço do servidor escolhido pelo ambiente. */
export function enderecoServidor(): string {
  return (process.env.GRIVER_SERVER_URL ?? SERVIDOR_PADRAO).replace(/\/$/, "")
}

export interface RestOpcoes {
  /** endereço do servidor (padrão: `GRIVER_SERVER_URL` ou 127.0.0.1:7331) */
  baseUrl?: string
  /** token fixo: pula a resolução em cascata */
  token?: string
  /** pasta de dados onde mora o arquivo `token` */
  dataDir?: string
}

export interface RestChamada {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  body?: unknown
}

export class GriverRestClient {
  private tokenCache = ""
  /** endereço informado na construção; sem ele, o do ambiente a cada chamada */
  private readonly baseUrlFixo: string | undefined
  private readonly tokenFixo: string
  private readonly dataDir: string | undefined

  constructor(opcoes: RestOpcoes = {}) {
    this.baseUrlFixo = opcoes.baseUrl?.replace(/\/$/, "")
    this.tokenFixo = opcoes.token?.trim() ?? ""
    this.dataDir = opcoes.dataDir
  }

  /**
   * O endereço do servidor.
   *
   * Sem endereço informado, o do ambiente vale a cada chamada: o servidor
   * pode ser apontado para outro lugar no meio da vida do processo.
   */
  get url(): string {
    return this.baseUrlFixo ?? enderecoServidor()
  }

  /**
   * Chama a API do servidor.
   *
   * Erros de HTTP viram `Error` com a mensagem do servidor — assim o
   * MCP mostra "receita não encontrada" e a linha de comando mostra a
   * mesma coisa.
   */
  async api<T = unknown>(caminho: string, chamada: RestChamada = {}): Promise<T> {
    const token = await this.token()
    let resposta = await this.pedir(caminho, chamada, token)

    // o servidor pode ter sido reiniciado com outro token — relê e tenta de novo
    if (resposta.status === 401) {
      this.tokenCache = ""
      const novo = await this.token()
      if (novo && novo !== token) resposta = await this.pedir(caminho, chamada, novo)
    }

    const texto = await resposta.text()
    let corpo: unknown
    try {
      corpo = texto ? JSON.parse(texto) : undefined
    } catch {
      corpo = texto
    }

    if (!resposta.ok) {
      if (resposta.status === 401) {
        throw new Error(
          "Token inválido ao falar com o Griver. O token esperado fica em " +
            "<projeto>/data/token — reinicie o servidor com `griver serve` a partir da pasta do projeto " +
            "ou exporte GRIVER_TOKEN com o valor correto.",
        )
      }
      if (resposta.status === 502) {
        throw new Error(
          "A extensão do Griver não respondeu. Abra o Chrome com a extensão carregada e a aba que você quer controlar.",
        )
      }
      const mensagem = (corpo as { error?: string } | undefined)?.error
      throw new Error(mensagem ?? `Griver respondeu HTTP ${resposta.status}`)
    }

    return corpo as T
  }

  private async pedir(
    caminho: string,
    chamada: RestChamada,
    token: string,
  ): Promise<Response> {
    return await fetch(`${this.url}${caminho}`, {
      method: chamada.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Griver-Token": token,
      },
      body: chamada.body === undefined ? undefined : JSON.stringify(chamada.body),
    })
  }

  /** O token em uso, resolvido uma vez e guardado em memória. */
  async token(): Promise<string> {
    if (this.tokenFixo) return this.tokenFixo
    if (this.tokenCache) return this.tokenCache

    this.tokenCache = this.tokenDoAmbiente() || this.tokenDoArquivo() || (await this.tokenDoServidor())
    return this.tokenCache
  }

  /**
   * O token do ambiente.
   *
   * `GRIVER_TOKEN` pode ser o próprio token ou o caminho do arquivo que o
   * guarda — o `readFileSync` decide: se o caminho existe, o conteúdo é
   * o token; se não existe, a variável é o token.
   */
  private tokenDoAmbiente(): string {
    const bruto = process.env.GRIVER_TOKEN?.trim()
    if (!bruto) return ""
    try {
      const conteudo = readFileSync(bruto, "utf8").trim()
      if (conteudo) return conteudo
    } catch {
      // não é um caminho: é o próprio token
    }
    return bruto
  }

  /** Token lido do arquivo de dados do projeto. */
  private tokenDoArquivo(): string {
    // o ambiente manda: quem configurou o token sabia o que estava fazendo
    const doAmbiente = this.tokenDoAmbiente()
    if (doAmbiente) return doAmbiente

    const candidatos = [
      this.dataDir ? join(this.dataDir, "token") : undefined,
      join(process.cwd(), "data", "token"),
    ].filter((c): c is string => Boolean(c))

    for (const candidato of candidatos) {
      try {
        const valor = readFileSync(candidato, "utf8").trim()
        if (valor) return valor
      } catch {
        // tenta o próximo
      }
    }
    return ""
  }

  /**
   * Pede o token ao próprio servidor.
   *
   * O arquivo `data/token` só vale quando o servidor roda na pasta do
   * projeto: iniciado de outro diretório, ele usa outra pasta de dados e
   * outro token — e as ferramentas levam 401 em tudo. O servidor entrega o
   * token dele em `/api/extension-token`, então essa rota é a fonte
   * confiável.
   */
  private async tokenDoServidor(): Promise<string> {
    try {
      const resposta = await fetch(`${this.url}/api/extension-token`)
      if (!resposta.ok) return ""
      const corpo = (await resposta.json()) as { token?: string }
      return typeof corpo.token === "string" ? corpo.token : ""
    } catch {
      return ""
    }
  }
}
