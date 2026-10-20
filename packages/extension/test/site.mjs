/**
 * Página de teste usada pelos e2e do navegador.
 *
 * Os testes preenchem um formulário e esperam a resposta na tela, então a
 * página precisa existir antes do Chrome abrir. Ela vivia solta em
 * `/tmp/opencode/teste.html`, criada à mão: numa máquina limpa — ou depois
 * de um `rm -rf /tmp` — a suíte morria com "net::ERR_FILE_NOT_FOUND" e
 * ninguém sabia dizer do que se tratava.
 *
 * Cada execução cria a sua, em pasta própria, e apaga no fim.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HTML = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>Formulário de teste</title>
  </head>
  <body>
    <h1 id="titulo">Teste</h1>
    <form id="form">
      <label for="nome">Nome</label>
      <input id="nome" name="nome" data-testid="campo-nome" />
      <label for="email">E-mail</label>
      <input id="email" name="email" type="email" />
      <select id="plano">
        <option value="basico">Básico</option>
        <option value="pro">Pro</option>
      </select>
      <button id="enviar" type="button" data-testid="botao-enviar">Enviar</button>
    </form>
    <p id="resultado" class="preco" hidden></p>
    <script>
      document.getElementById("enviar").addEventListener("click", () => {
        const nome = document.getElementById("nome").value
        const plano = document.getElementById("plano").value
        const saida = document.getElementById("resultado")
        saida.textContent = \`Olá \${nome}, plano \${plano}\`
        saida.hidden = false
      })
    </script>
  </body>
</html>
`

/**
 * Cria a página de teste e devolve o endereço para abrir.
 *
 * O `url` é o que os testes recebem; `limpar` apaga a pasta temporária.
 */
export function criarSiteTeste() {
  const pasta = mkdtempSync(join(tmpdir(), "griver-site-"))
  const arquivo = join(pasta, "teste.html")
  writeFileSync(arquivo, HTML, "utf8")

  return {
    url: `file://${arquivo}`,
    limpar() {
      try {
        rmSync(pasta, { recursive: true, force: true })
      } catch {
        // a pasta temporária pode ficar para trás; não é motivo para falhar
      }
    },
  }
}
