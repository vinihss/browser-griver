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
pnpm install          # com rede
pnpm vendor           # sem rede: copia os pacotes disponíveis na máquina
pnpm build            # compila core, server, cli e a extensão
```

O `vendor` existe porque o ambiente de desenvolvimento pode não ter acesso ao
registry npm. Ele copia `zod`, `ws`, `typescript`, `esbuild`, `tsx` e
`playwright` de cópias locais e cria os links do workspace.

## Colocando de pé

```sh
# 1. suba o servidor (imprime o token)
pnpm dev:server
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

## CLI

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
griver schedule list|add|rm                     # agendamentos por cron
griver chat "adicione um passo que extraia o preço"
```

`griver run` roda sem o servidor no ar — ele abre o banco e executa direto.
Para aproveitar a sessão logada do navegador, use `--driver cdp` com um Chrome
aberto em `--remote-debugging-port=9222`.

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
| `griver_recipe_patch` | adiciona, altera, remove ou move passos |
| `griver_recipe_validate` | valida contra o alvo |
| `griver_page_context` | inspeciona a aba ativa |
| `griver_page_click` / `griver_page_fill` | age na aba — **pede aprovação** |
| `griver_run` | executa uma receita |

O servidor MCP precisa do build (`pnpm build`) e do servidor do Griver no
ar. O token é o mesmo da extensão — `<projeto>/data/token` — e o endereço
do servidor vem de `GRIVER_SERVER_URL` (padrão `http://127.0.0.1:7331`).

## Estrutura

```
packages/core        AST da receita, interpretador, compiladores, protocolo WS
packages/server      REST + WebSocket + SQLite + drivers + ponte OpenCode + MCP
packages/cli         binário `griver`
packages/extension   extensão MV3 (esbuild + TypeScript, sem framework)
.opencode/agents/griver.md  agente do assistente
```

O `@griver/core` não importa nada do Node: a extensão e o servidor usam o
**mesmo** schema, o **mesmo** interpretador e o **mesmo** protocolo.

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
