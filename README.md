# Griver

Automatizador de browser local com extensão do Chrome conectada. Você grava
o que faz numa página, o Griver transforma isso em uma **receita** (um script
em JSON), e você pode executar a mesma receita na aba atual, em um navegador
headless ou no nível do sistema via Firecrawl. Um assistente de IA integrado
ajuda a montar e estender esses scripts.

```
┌─────────────────────┐   WebSocket    ┌───────────────────────────┐
│  Extensão Chrome    │◄──────────────►│  Servidor local Griver   │
│  • painel lateral   │   REST         │  • SQLite (node:sqlite)  │
│  • gravador         │                │  • interpretador de AST   │
│  • executor na aba  │                │  • drivers (PW/Firecrawl) │
└─────────────────────┘                └────────────┬──────────────┘
                                                     │ Basic auth
                                              ┌──────▼────────┐
                                              │ OpenCode      │  ← motor do chat
                                              │ (local)       │
                                              └───────────────┘
```

## Requisitos

| Item | Versão |
|---|---|
| Node.js | 22.5+ (usa `node:sqlite`) |
| Chrome / Chromium | 116+ (MV3, painel lateral) |
| Playwright | opcional — só para execução headless |
| Firecrawl | opcional — só para o alvo `os` (`FIRECRAWL_API_KEY`) |
| OpenCode | opcional — só para o chat (`opencode` rodando localmente) |

## Instalação

```sh
pnpm bootstrap
```

Um comando só: instala as dependências, compila o core, o servidor, a CLI e
a extensão, linka o `griver` no diretório global de binários — para o
comando existir em qualquer pasta — e gera o `griver-extension.zip`.

Ele tenta o `pnpm install` primeiro. Sem acesso ao registry npm — o caso do
ambiente de desenvolvimento desta máquina — ele recorre ao
`scripts/vendor-offline.mjs`, que copia os pacotes disponíveis na máquina.
As fontes do vendor podem ser apontadas com `GRIVER_VENDOR_SOURCES`
(separadas por `:`).

Para desfazer o link global:

```sh
npm unlink -g @griver/cli
```

### As tarefas

Todas moram em `scripts/tasks.mjs` — um lugar só. De dentro do projeto, os
atalhos são `pnpm <tarefa>`; o mesmo caminho pelo repositório é
`./bin/griver <tarefa>`.

| Tarefa | O que faz |
|---|---|
| `pnpm bootstrap` | o caminho completo: instala, compila, linka e empacota |
| `pnpm deps` | só as dependências (pnpm, com o vendor offline de reserva) |
| `pnpm build` | compila core, server, cli e a extensão |
| `pnpm typecheck` | confere os tipos de tudo, inclusive da extensão |
| `pnpm test` | os testes unitários dos três pacotes |
| `pnpm test:e2e:all` | a suíte end-to-end (Chromium de verdade, headless) |
| `pnpm package` | gera o `griver-extension.zip` |
| `pnpm schema` | gera o `docs/recipe.schema.json` a partir do schema Zod |
| `pnpm link-cli` | linka o `griver` no diretório global de binários |
| `pnpm clean` | remove `dist`, `tsbuildinfo` e o zip |
| `pnpm dev:server` | sobe o servidor local |
| `pnpm dev:cli` | roda a CLI a partir do fonte |
| `pnpm dev` | extensão em watch + servidor no ar |

> Os nomes fogem dos comandos reservados do pnpm: `setup`, `install` e
> `link` já são comandos do pnpm (`pnpm setup` instala o pnpm globalmente),
> e um atalho com o mesmo nome faria outra coisa.

## Colocando de pé

```sh
# 1. suba o servidor (imprime o token)
griver serve
# griver 0.1.0 ouvindo em http://127.0.0.1:7331
#   dados:    /caminho/do/projeto/data
#   token:    Gey1-t9cbw-GJlZx2UnoruawIYMPOgiE
#   extensão: ws://127.0.0.1:7331/ws

# 2. carregue a extensão
#    chrome://extensions → ative "Modo do desenvolvedor" → "Carregar sem compactação"
#    → selecione packages/extension/dist

# 3. no painel lateral (ícone do Griver na barra), aba "Ajustes":
#    confirme o endereço e clique em Conectar
```

> O servidor precisa subir a partir da raiz do projeto: a pasta de dados
> (`./data`) sai do diretório de onde o comando foi chamado, e é ela que o
> CLI e a extensão procuram. `pnpm dev:server` faz o mesmo, a partir da
> raiz.

> O token é buscado automaticamente pela extensão. Ele continua sendo exigido
> pela API (protege as receitas contra páginas da web) — só não precisa mais ser
> copiado à mão.

> O Chrome de marca ignora a flag `--load-extension`. Para carregar a extensão
> automaticamente em testes, use o Chromium (`chromium.launchPersistentContext`
> do Playwright) — é o que o teste end-to-end faz.

## Usando a extensão

O painel lateral mostra **uma tela por vez**, alternada pelos botões do
cabeçalho: **☰ Receitas**, **✦ Chat** e **⚙ Ajustes**.

**Receitas** — a tela principal é só a lista das receitas do servidor, todas
elas, sem filtro de projeto. Cada linha traz o título e dois botões: **✎**
edita e **▶** executa na aba atual.

Para criar ou alterar, clica-se numa linha — ou no **+** do cabeçalho — e a
**tela de edição** abre, com o campo **Nome**, o editor em JSON e os botões:

- *Salvar* — cria a receita (se é nova) ou grava o JSON editado. Não há campo
  de URL: a `startUrl` é a da página em que você está
- *Validar* — confere se os passos existem no alvo escolhido
- *Executar aqui* — roda na aba atual
- *Exportar* — copia o código Playwright/Firecrawl gerado
- *Remover* — apaga a receita (ou descarta a gravação, se ainda não salva)

O botão **● Gravar** fica no cabeçalho da própria tela de edição — gravar é
uma ação sobre a receita que está aberta. Ele não é uma tela: injeta uma
**barra de controle na página**, e é de lá que a gravação também é controlada:

1. Abra a página e clique em **● Gravar**
2. Interaja normalmente — cliques, digitação, seleções e teclas são capturados
3. O contador *gravando · N passos* corre na tela de edição, e a página pode
   ser fechada e reaberta sem perder a captura
4. **⏸ / ⏺** na barra pausa e retoma a captura sem perder o contexto
5. **⏹ Stop** — na barra ou na tela de edição — encerra a gravação
6. A barra some da página e os passos abrem sozinhos na tela de edição, para
   ajustar antes de salvar

A barra de gravação sobrevive a navegações: o estado da gravação mora no
service worker, não na página. É por isso que o primeiro passo — quase sempre
a URL inicial — não se perde. Cada navegação entra na receita como passo
`navigate` e senhas viram `{{secret}}` em vez do valor real.

**Chat** — conversa com o assistente. Ele lê e edita receitas, inspeciona a
aba e executa ações no browser **mediante sua aprovação**.

**Ajustes** — endereço do servidor e token.

O mapa das telas, a estrutura do código da extensão e o troubleshooting
dela estão em [docs/EXTENSAO.md](./docs/EXTENSAO.md).

## O formato da receita

Uma receita é um JSON com um formato único, executado em dois alvos:

```jsonc
{
  "version": 1,
  "startUrl": "https://loja.exemplo.com",
  "vars": { "usuario": "ana" },
  "steps": [
    { "id": "n1", "type": "navigate", "url": "https://loja.exemplo.com/login" },
    {
      "id": "f1",
      "type": "fill",
      "target": { "selectors": ["#email", "input[name=email]"] },
      "value": "{{usuario}}"
    },
    { "id": "c1", "type": "click", "target": { "selectors": ["#entrar"] } },
    {
      "id": "e1",
      "type": "extract",
      "target": { "selectors": [".preco"] },
      "saveAs": "preco"
    },
    {
      "id": "i1",
      "type": "if",
      "condition": { "kind": "compare", "left": "{{preco}}", "op": "<", "right": "100" },
      "then": [{ "id": "c2", "type": "click", "target": { "selectors": ["#comprar"] } }]
    },
    {
      "id": "a1",
      "type": "assert",
      "target": { "selectors": ["#confirmado"] },
      "expect": { "kind": "visible" }
    }
  ]
}
```

### Passos disponíveis

| Passo | browser | os | O que faz |
|---|:--:|:--:|---|
| `navigate` | ✓ | ✓ | Abre uma URL |
| `click` | ✓ | ✓ | Clica em um elemento |
| `fill` | ✓ | ✓ | Preenche um campo |
| `press` | ✓ | ✓ | Pressiona uma tecla |
| `select` | ✓ | | Escolhe uma opção de `<select>` |
| `hover` | ✓ | | Passa o mouse (abre menus) |
| `scrollTo` | ✓ | | Rola até um elemento |
| `upload` | ✓ | | Envia arquivos |
| `wait` | ✓ | ✓ | Pausa fixa |
| `waitFor` | ✓ | ✓ | Espera um elemento |
| `extract` | ✓ | ✓ | Lê um valor e salva numa variável |
| `assert` | ✓ | ✓ | Verifica a página — falha interrompe |
| `set` | ✓ | ✓ | Define uma variável |
| `if` / `loop` | ✓ | ✓ | Controle de fluxo |
| `script` | ✓ | | JavaScript no contexto da página |
| `screenshot` | ✓ | | Captura de tela |

### Seletores

`target.selectors` é uma **lista de candidatos** testados em ordem. O gravador
gera essa lista por prioridade:

```
[data-testid]  →  #id  →  [name]  →  [aria-label]  →  [placeholder]  →  classes estáveis  →  caminho nth-of-type
```

Cada passo guarda o texto do elemento como fallback extra. Isso torna a
receita resistente a mudanças de markup — basta um candidato continuar
valendo.

### Variáveis e condições

`extract` grava o valor lido; `{{variavel}}` interpola em qualquer string
(url, valor digitado, comparação). As condições aceitam `compare` (`==`, `!=`,
`>`, `>=`, `<`, `<=`, `contains`, `matches`), `truthy`, `and`, `or` e `not`.

## A API do servidor

O servidor fala três protocolos: **REST** (JSON em `http://127.0.0.1:7331`),
**WebSocket** (`/ws`, o canal da extensão) e **MCP** (stdio, o canal do
assistente). A referência completa — cada endpoint, o handshake do
WebSocket, as ferramentas do MCP e os exemplos de `curl` — está em
[docs/API.md](./docs/API.md).

## CLI

O `griver` fica disponível em qualquer pasta depois do `pnpm bootstrap` (o
link global é o que o coloca no `PATH`).

```sh
griver serve [--port 7331] [--data-dir ./data]   # servidor + WebSocket
griver doctor                                   # checa o ambiente
griver cleanup                                  # encerra servidores órfãos
griver project list|create|show|rm
griver recipe list|new|show|export|validate|set|rm
griver recipe history <id>                      # revisões
griver recipe diff <id> <revisão>               # compara com uma revisão
griver recipe restore <id> <revisão>            # volta para uma revisão
griver run <receita> [--target browser|os] [--driver playwright|cdp]
                       [--headed] [--var k=v] [--json]
griver run list                                 # execuções recentes
griver run cancel <id>                          # cancela uma execução
griver schedule list|add|rm                     # agendamentos por cron
griver page context                             # inspeciona a aba ativa
griver page click <seletor> [--text "texto"]    # clica na aba ativa
griver page fill <seletor> <valor>              # preenche um campo
griver page screenshot [--out arquivo.png]      # captura a tela
griver record state|start|pause|resume|stop|discard
griver chat "adicione um passo que extraia o preço"
```

`griver run` roda sem o servidor no ar — ele abre o banco e executa direto.
Para aproveitar a sessão logada do navegador, use `--driver cdp` com um Chrome
aberto em `--remote-debugging-port=9222`.

`griver run list` e `griver run cancel` falam com o **servidor**: o histórico
das execuções mora lá, junto com a extensão que as rodou.

### Operar o Griver pelo terminal

`page` e `record` falam com o **servidor local**, e não com o banco: quem
age na aba é a extensão, e quem manda nela é o servidor. Por isso eles
precisam do servidor no ar (`griver serve`) e da extensão carregada no
Chrome.

O `record` é a mesma gravação do painel, com o mesmo resultado: o terminal
comanda, a extensão captura e a receita volta pronta.

```sh
griver record start                    # começa a gravar a aba ativa
griver page click "#login-email"       # a interação vira passo da receita
griver page fill "#login-email" "ana@exemplo.com"
griver record stop                     # imprime a receita (--out arquivo.json)
griver record stop --out receita.json  # salva a receita em arquivo
```

O `griver recipe set <id> --file receita.json` leva a receita gravada para
o servidor.

### O mesmo toolset no MCP

O assistente e a linha de comando usam a **mesma camada de operações**
(`packages/server/src/ops.ts`): uma ação do Griver não pode se comportar de
um jeito no terminal e de outro no assistente. São 30 ferramentas no MCP
(`griver_recipe_new`, `griver_page_click`, `griver_record_start`…), com o
mesmo resultado e o mesmo texto de erro.

O que o MCP acrescenta à linha de comando é a conversa: o assistente escolhe
a ferramenta, pede a aprovação das ações que agem na página (`page_click`,
`page_fill`, `run`, `recipe_delete`…) e monta a receita passo a passo.

### Servidores órfãos

Um servidor que sobrevive a quem o started vira órfão: segura a porta e a
memória sem ninguém para falar com ele. Numa máquina de desenvolvimento alguns
chegam a ocupar gigabytes de RAM.

O dono do servidor é o líder da sessão dele — o shell que pediu o servidor.
Quando esse líder morre, o servidor fica sozinho. É a mesma regra do servidor
(que se encerra sozinho) e do limpador:

```sh
griver cleanup          # encerra os órfãos e mostra quais eram
griver cleanup --json   # a mesma coisa, em JSON
```

Quem tem dono vivo fica intacto. O limpador também se poupa: um servidor que
foi started por um processo que já morreu é órfão, mas o dono dele é ele
mesmo — e a limpeza não derruba a si próprio.

### O servidor detached

Um servidor em `setsid` (ou `&` de um script que já terminou) sobrevive a
quem o started: ele está na sessão dele, e o shell que o mandou já foi
embora. Para esses casos, quem sobe o servidor diz por herança quem é o
dono:

```sh
GRIVER_CRIADOR=$$ setsid griver serve &
```

Sem essa herança, o servidor só descobre o dono pelo `/proc` — e o `/proc`
não lembra de quem era filho um processo que já foi reparentado para o init.
Quando o dono morre na largada (um script que sobe o servidor e sai), o
servidor fica órfão sem ninguém para derrubar.

### A pasta de dados

Todos — servidor, CLI e extensão — usam a mesma pasta: `<projeto>/data`.
Ela sai do diretório de onde o processo foi chamado, então o servidor precisa
subir a partir da raiz do projeto:

```sh
cd /home/vinicius/browser-griver && pnpm dev:server
```

Quem sobe por systemd aponta a pasta explicitamente, para não depender do
diretório de trabalho da unidade:

```ini
[Service]
WorkingDirectory=/home/vinicius/browser-griver
Environment=GRIVER_DATA_DIR=/home/vinicius/browser-griver/data
ExecStart=/home/vinicius/browser-griver/node_modules/.bin/tsx packages/server/src/main.ts
```

Com a pasta errada, o servidor sobe com um token e o CLI procura outro — e
toda chamada leva 401.

## O assistente de IA

O chat usa o **servidor local do OpenCode** como motor. O agente `griver`
(`.opencode/agents/griver.md`) define o comportamento do assistente e as
permissões dele.

As ferramentas chegam por **MCP**: o servidor do Griver é também um
servidor MCP (`packages/server/src/mcp`), e o `opencode.json` do projeto o
registra com o nome `griver`. Assim, o assistente do terminal e o do painel
da extensão usam as mesmas ferramentas — ler, editar e validar receitas,
inspecionar a aba e disparar execuções.

| Ferramenta | O que faz |
|---|---|
| `griver_recipe_list` | lista projetos e receitas |
| `griver_recipe_get` | lê uma receita |
| `griver_recipe_new` | cria uma receita vazia |
| `griver_recipe_update` / `griver_recipe_delete` | renomeia, troca o alvo, apaga |
| `griver_recipe_patch` | adiciona, altera, remove ou move passos |
| `griver_recipe_validate` | valida contra o alvo |
| `griver_recipe_history` / `griver_recipe_restore` | revisões da receita |
| `griver_recipe_export` | gera o código Playwright ou Firecrawl |
| `griver_project_list` / `griver_project_create` / `griver_project_delete` | projetos |
| `griver_page_context` | inspeciona a aba ativa |
| `griver_page_click` / `griver_page_fill` | age na aba — **pede aprovação** |
| `griver_page_screenshot` | captura a tela da aba |
| `griver_record_start` / `pause` / `resume` / `stop` / `discard` / `state` | grava a aba |
| `griver_run` / `griver_run_list` / `griver_run_get` / `griver_run_cancel` | execuções |
| `griver_schedule_list` / `griver_schedule_add` / `griver_schedule_remove` | agendamentos |

As ferramentas que agem na página ou destroem alguma coisa pedem
aprovação: `page_click`, `page_fill`, `run`, `recipe_delete`, `project_delete`
e `schedule_remove`.

O servidor MCP precisa do build (`pnpm build`) e do servidor do Griver no
ar. O token é o mesmo da extensão — `<projeto>/data/token` — e o endereço
do servidor vem de `GRIVER_SERVER_URL` (padrão `http://127.0.0.1:7331`).

## Estrutura

```
packages/core        AST da receita, interpretador, compiladores, protocolo WS
packages/server      REST + WebSocket + SQLite + drivers + ponte OpenCode + MCP
packages/cli         binário `griver`
packages/extension   extensão MV3 (esbuild + TypeScript, sem framework)
scripts/tasks.mjs    o ponto único das tarefas (install, build, test, e2e…)
bin/griver           a entrada do repositório: tarefa ou CLI
docs/                a API, a arquitetura e a extensão
.opencode/agents/    o agente do assistente e o de desenvolvimento
```

A camada de operações (`packages/server/src/ops.ts`) é o meio-termo: o MCP
(`packages/server/src/mcp/`) e a linha de comando (`packages/cli/`) chamam as
mesmas funções, então o comportamento é o mesmo nos dois canais.

O `@griver/core` não importa nada do Node: a extensão e o servidor usam o
**mesmo** schema, o **mesmo** interpretador e o **mesmo** protocolo.

A arquitetura em detalhe — as camadas, as invariantes e as decisões que já
custaram tempo — está em [docs/ARQUITETURA.md](./docs/ARQUITETURA.md).

## Como a execução funciona

| Situação | Motor | Onde roda |
|---|---|---|
| *Executar aqui* | executor DOM na aba | extensão |
| *Executar headless* | Playwright / Puppeteer | servidor |
| Alvo `os` | Firecrawl (`/scrape`, `/extract`, `/crawl`, `/map`, `/search`) | servidor |

O interpretador é o mesmo nos três casos: ele só fala com a interface `Driver`.
Na aba, o service worker envia um passo por vez ao content script; navegações
são tratadas pelo próprio service worker porque recarregam a página.

## Testes

```sh
pnpm test                                       # testes do core e do servidor
pnpm test:e2e:all                               # a suíte inteira da extensão
pnpm test:e2e:headless                          # a mesma suíte, sem tela
pnpm test:e2e:painel                            # gravar, salvar e executar pela UI
pnpm test:e2e:uso                               # projetos, execução e chat de ponta a ponta
pnpm test:e2e:browser                           # ciclo completo no Chromium
pnpm test:e2e:chat                              # o assistente edita a receita
```

### Os e2e sem tela

Os e2e abrem um Chromium de verdade e carregam a extensão nele. O
Playwright tem dois Chromium: o *headless shell*, que é o padrão do
`headless: true` e **não carrega extensão nenhuma**, e o Chromium completo,
que carrega a extensão MV3 em headless como qualquer outro. A diferença é
o `channel: "chromium"` — sem ele, o service worker da extensão nunca
aparece e o teste morre fingindo que a extensão não carregou.

Por isso os e2e rodam **headless por padrão**: o Chrome de verdade depende
de um X server e morre sozinho quando o Xwayland engasga — o teste falha
com "Target page, context or browser has been closed", sem dizer que o
culpado é o navegador. No headless a suíte é determinística e não
precisa de tela nenhuma (CI, sessão sem Wayland, `sudo` sem display).

```sh
GRIVER_HEADLESS=0 pnpm test:e2e:all   # o Chrome de verdade: exige tela
```

O teste do painel usa a interface como uma pessoa: escolhe o projeto, grava um
formulário, conclui, salva a receita, edita o JSON, salva de novo e executa —
conferindo que os passos chegaram ao servidor e que a página terminou no estado
esperado. Ele apaga o projeto que criou ao final.

## Problemas comuns

Os problemas da extensão têm um guia próprio, com o mapa das telas e os
erros mais comuns: [docs/EXTENSAO.md](./docs/EXTENSAO.md#troubleshooting).

**"token inválido"** — a extensão busca o token sozinha ao conectar. Se a
mensagem aparecer, clique em *Conectar* na aba **Ajustes**: o token guardado
provavelmente é de um servidor antigo. O arquivo atual é `data/token`.

**Clico em Gravar e nenhum passo aparece** — a extensão precisa rodar na página.
Se a aba já estava aberta antes de você carregar a extensão, ela é injetada na
hora; se ainda assim falhar, recarregue a aba (F5). Páginas internas do
navegador (`chrome://`, Web Store) não podem ser gravadas — o painel mostra um
aviso nesses casos. Para páginas `file://`, ative *Permitir acesso a URLs de
arquivo* em `chrome://extensions`.

**"Execução falhou: Navigation rejected."** — versões recentes do Chrome só
deixam a extensão navegar abas para as quais ela tem permissão de host. Se a
extensão foi carregada antes da versão atual do `manifest.json`, recarregue-a em
`chrome://extensions`. A execução também tenta navegar pelo content script
quando o Chrome recusa a chamada, então a receita segue funcionando mesmo com
*acesso ao site* restrito — mas a gravação precisa da permissão.

**Os projetos não aparecem** — a lista carrega ao abrir o painel e ao reconectar.
Se estiver vazia com o status "conectado", clique em *Atualizar* na aba
**Projetos**; se persistir, confira o token em **Ajustes**.

**A primeira mensagem do chat some** — o texto digitado antes de existir uma
conversa é guardado e enviado assim que a sessão abre. Se a conversa estiver
"abrindo" por muito tempo, o servidor não achou o OpenCode: confira
`opencode service status`.

**A extensão não conecta** — o servidor escuta só em `127.0.0.1`. Confira se a
URL no painel é `http://127.0.0.1:7331`.

**"nenhum seletor casou"** — a página mudou desde a gravação. Abra a receita,
ajuste o seletor ou grave de novo. O erro lista os seletores tentados.

**O serviço worker "dormiu"** — o MV3 encerra workers ociosos. A extensão
mantém uma conexão WebSocket e um `chrome.alarms` de 24 s para não dormir; se
acontecer, o status no painel vira "desconectado" e ele reconecta sozinho.

**Passo não suportado no alvo `os`** — `select`, `hover`, `upload`, `script` e
`screenshot` só existem no alvo `browser`. O *Validar* aponta isso antes de
salvar.
