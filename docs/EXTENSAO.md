# A extensão

O que o Griver faz dentro do Chrome: o painel lateral, a gravação que vira
receita e a execução dos passos na aba. Para o servidor e a API, veja
[API.md](./API.md).

## O que ela é

A extensão tem três partes, cada uma em um contexto do Chrome:

| Parte | Onde roda | O que faz |
|---|---|---|
| **Service worker** | `src/background/` | fala com o servidor por WebSocket, guarda o token, manda a extensão executar uma receita na aba |
| **Content script** | `src/content/` | o que roda dentro da página: o executor dos passos, o gravador e a barra de gravação |
| **Painel** | `src/panel/` | a interface: a lista de receitas, a tela de edição, o chat e os ajustes |

O service worker é o único que fala com o servidor. O content script é
injetado só nas páginas `http`, `https` e `file`, e o painel é uma página da
própria extensão.

## O painel

Uma tela por vez, alternada pelos botões do cabeçalho:

```
┌──────────────────────────────────────────────┐
│ [+]            ☰ Receitas  ✦ Chat  ⚙ Ajustes │
└──────────────────────────────────────────────┘
      │            │          │         │
      ▼            ▼          ▼         ▼
  tela de      lista de    conversa   servidor
   edição      receitas                e token
```

- **☰ Receitas** — a lista de todas as receitas do servidor, sem filtro de
  projeto. Cada linha tem **✎** (editar) e **▶** (executar na aba atual).
- **✎ / +** — a tela de edição: o campo **Nome**, o editor em JSON e os
  botões **Salvar**, **Validar**, **Executar aqui**, **Exportar** e
  **Remover**. O **● Gravar** fica no cabeçalho da própria tela: gravar é
  uma ação sobre a receita que está aberta.
- **✦ Chat** — a conversa com o assistente. Ele lê e edita receitas,
  inspeciona a aba e executa ações no browser **mediante sua aprovação**.
- **⚙ Ajustes** — o endereço do servidor e o token.

Não há campo de URL no editor: a `startUrl` da receita é a da página em que
você está.

## A gravação

A gravação não vive no painel: ela vira uma **barra de controle dentro da
página**, e é de lá que também se controla a captura.

```
┌─────────────────────────────────────────┐
│  ⏺ ⏸ ⏹                    Cancel       │
└─────────────────────────────────────────┘
   ↑ só existe enquanto a captura corre; ao parar ela some
```

O fluxo:

1. **● Gravar** na tela de edição → a barra aparece na aba ativa
2. **Interaja** — cliques, preenchimentos, seleções, teclas e navegações
   viram passos
3. O contador *gravando · N passos* corre na tela de edição
4. **⏸ / ⏺** na barra pausa e retoma a captura
5. **⏹ Stop** — na barra ou na tela de edição — encerra
6. A barra some da página e os passos abrem na tela de edição, prontos para
   ajustar e salvar

A barra sobrevive a navegações: o estado da gravação mora no service
worker, não na página. É por isso que o primeiro passo — quase sempre a URL
inicial — não se perde.

Cada navegação entra na receita como passo `navigate`, e senhas viram
`{{secret}}` em vez do valor real.

### Quem é a dona da gravação

Cada extensão tem a sua. Os passos capturados por uma não podem entrar na
receita de outra, senão a receita sai com passos que nunca aconteceram. A
gravação aberta pela linha de comando (sem dona) é adotada pela primeira
extensão que falar dela.

## A execução na aba

O **▶** de uma linha, ou o **Executar aqui** do editor, roda a receita na
aba atual:

- o servidor cria a execução e manda `run.request` para a extensão
- a extensão executa um passo por vez e reporta `run.event` a cada passo
- no fim, `run.result` fecha a execução

A execução **headless** (Playwright no servidor, ou Firecrawl para o alvo
`os`) continua disponível pela CLI e pela API — o painel lateral roda na
aba.

## O arquivo da extensão

```
packages/extension/
├── manifest.json          MV3: permissões, host_permissions, service worker
├── build.mjs              o empacotamento (esbuild)
└── src/
    ├── background/
    │   ├── index.ts       o service worker: WebSocket, gravação, execução
    │   ├── ws-client.ts   o WebSocket com reconexão e heartbeat
    │   └── tab-driver.ts  o driver da aba (executa os passos)
    ├── content/
    │   ├── index.ts       o roteador de mensagens da página
    │   ├── executor.ts    executa um passo (clique, preenchimento, leitura)
    │   ├── recorder.ts    captura os eventos da página
    │   ├── overlay.ts     a barra de gravação dentro da página
    │   └── selector.ts    os candidatos de seletor, por prioridade
    ├── panel/
    │   ├── app.ts         a troca de telas
    │   ├── state.ts       o estado do painel
    │   ├── api.ts         as chamadas REST
    │   ├── dom.ts         as funções de DOM
    │   └── views/         receitas, chat e ajustes
    ├── shared/constants.ts
    └── styles.css
```

O `manifest.json` é a fonte da verdade das permissões: `host_permissions`
diz em que páginas a extensão pode injetar o content script, e é o que
define quem pode ser automatizado.

## Desenvolvimento

```sh
pnpm build          # compila core, server, cli e a extensão
pnpm dev            # extensão em watch + servidor no ar
pnpm typecheck      # confere os tipos de tudo, inclusive da extensão
```

A extensão é empacotada pelo esbuild: o content script sai como IIFE (o
Chrome não aceita ESM em content script) e o service worker e o painel como
módulos. O bundle não avisa sobre função inexistente — o typecheck é o que
pega isso antes do build.

Para carregar no Chrome: `chrome://extensions` → *Modo do desenvolvedor* →
*Carregar sem compactação* → `packages/extension/dist`.

## Troubleshooting

### "Não foi possível conectar ao servidor"

1. O servidor está rodando? `curl http://127.0.0.1:7331/api/health`
2. O Chrome tem permissão para acessar a porta?
3. Clique em *Conectar* na aba **Ajustes** — o painel guarda o endereço em
   memória, e ele pode estar apontando para outro servidor

### "token inválido"

A extensão busca o token sozinha ao conectar. Se a mensagem aparecer,
clique em *Conectar* na aba **Ajustes**: o token guardado é provavelmente de
um servidor antigo. O arquivo atual é `data/token`.

### Extensão não carrega

1. Carregue a **pasta** `packages/extension/dist`, não o zip
2. Veja o console do Chrome (F12) por erros
3. O `dist` é apagado no começo de cada build — recarregue a extensão depois
   do build, não durante

### "onRuntimeMessage is not defined" / "header is not defined"

O painel abriu, mas o JavaScript quebrou na hora de renderizar. **Causa:**
alguma função chamada em `app.ts` deixou de existir — o esbuild empacota o
bundle sem avisar, e o erro só aparece em runtime. **Como evitar:** rode o
typecheck antes de buildar (`pnpm typecheck`); ele acusa função inexistente,
símbolo não importado e variável fora de escopo.

### A barra de gravação não aparece na página

1. A página é `http`/`https`/`file` — `chrome://` não aceita extensão
2. Olhe o console da página (F12): erros de CSP aparecem lá
3. Recarregue a aba — o content script só é injetado em páginas já abertas
   quando a extensão é recarregada

### Passos duplicados na gravação

Cada evento é contado uma vez. Se aparecer duplicado, são duas extensões
conectadas ao mesmo servidor: feche as outras abas do Chrome.

### A receita não aparece na lista

1. A lista mostra **todas** as receitas do servidor, sem filtro de projeto
2. Se o servidor estiver fora do ar, o painel mostra o aviso de conexão
3. Clique em **☰** (Receitas) para voltar à lista
