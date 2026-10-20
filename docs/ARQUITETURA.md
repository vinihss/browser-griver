# Arquitetura

Como o Griver é organizado, o que cada camada é dona e o que não pode
mexer. O README diz como usar; este documento diz por que o código é assim.

## As camadas

```
                    ┌──────────────────────────────┐
   extensão ──────►│  servidor local (node)        │
   (Chrome)         │  • dono do estado (SQLite)    │
   WebSocket        │  • interpretador da receita   │
                    │  • drivers (Playwright/Firecrawl)
                    └───────────┬──────────────────┘
                                │ REST
                    ┌───────────▼──────────────────┐
   CLI ────────────►│  operações (ops.ts)           │
   MCP ────────────►│  a fonte única da semântica   │
   painel ─────────►└──────────────────────────────┘
```

| Pacote | O que é | O que ele **não** faz |
|---|---|---|
| `@griver/core` | o schema da receita, o interpretador, os compiladores e o protocolo WebSocket | não importa nada do Node — é o mesmo código na extensão e no servidor |
| `@griver/server` | o dono do estado: REST, WebSocket, SQLite, drivers, ponte com o OpenCode e o servidor MCP | não fala com a página: quem age na aba é a extensão |
| `@griver/cli` | o `griver` do terminal | não tem regra própria: chama a camada de operações |
| `@griver/extension` | o painel, o gravador e o executor dentro da aba | não guarda nada: o estado mora no servidor |

O `core` sem dependência do Node é o que permite a extensão e o servidor
compartilharem o **mesmo** schema, o **mesmo** interpretador e o **mesmo**
protocolo. Um passo que funciona no servidor funciona na aba, porque é o
mesmo código decidindo.

## Onde cada coisa mora

| Pasta | O que tem |
|---|---|
| `packages/core/src/recipe/` | o schema da receita (Zod), a validação por alvo, o JSON Schema e as palavras-chave do editor |
| `packages/core/src/runtime/` | o interpretador: ele executa a receita contra a interface `Driver` |
| `packages/core/src/compiler/` | Playwright e Firecrawl: receita → código |
| `packages/core/src/protocol/` | as mensagens do WebSocket, dos dois lados |
| `packages/server/src/http/` | o roteador e as rotas REST |
| `packages/server/src/ws/` | o gateway da extensão: conexões, eventos e requisições com resposta |
| `packages/server/src/db/` | o SQLite e o repositório (a única parte que escreve no banco) |
| `packages/server/src/runner/` | as execuções: no servidor (`runner/index.ts`) e na aba (`runner/tab.ts`) |
| `packages/server/src/recording/` | a gravação em andamento, em memória |
| `packages/server/src/opencode/` | a ponte com o OpenCode local (o motor do chat) |
| `packages/server/src/ops.ts` | as operações: uma por ação, com o nome que o canal usa |
| `packages/server/src/mcp/` | o servidor MCP e as 30 ferramentas |
| `packages/server/src/drivers/` | Playwright e Firecrawl como drivers do interpretador |
| `packages/extension/src/background/` | o service worker: WebSocket, gravação e execução na aba |
| `packages/extension/src/content/` | o que roda dentro da página: executor, gravador, overlay |
| `packages/extension/src/panel/` | o painel lateral: telas, estado e chamadas REST |
| `scripts/tasks.mjs` | o ponto único das tarefas (instalar, compilar, testar, empacotar) |
| `bin/griver` | a entrada do repositório: tarefa ou CLI |
| `docs/` | a API, a arquitetura e a extensão |

## As invariantes

Cinco regras que o código respeita e que qualquer mudança precisa respeitar.

### 1. O servidor é dono do estado

Receitas, execuções, revisões, agendamentos e conversas vivem no SQLite do
servidor. A CLI, o MCP e o painel **não abrem o banco**: eles falam com o
REST. Por isso o mesmo dado visto por três canais é o mesmo dado — e por
isso o token é o que separa a confiança do acesso.

### 2. Quem age na aba é a extensão

O servidor manda; a extensão executa. Isso vale para a gravação (a extensão
injeta o gravador e manda os eventos) e para a execução na aba (a
extensão recebe `run.request` e devolve `run.result`).

A consequência prática: `page` e `record` só funcionam com o servidor **e**
a extensão no ar. Sem extensão, a resposta é `502` ou `commanded: false` —
e o motivo está no campo, não num palpite.

### 3. O token protege o REST, e o CORS protege o token

O token é exigido em todas as rotas menos três. Ele é entregue à extensão
por `/api/extension-token`, que só responde a quem não é uma página da web
(sem header `Origin` ou com `Origin: chrome-extension://`), e o CORS só
libera origens de extensão. O servidor escuta em loopback: ele não deve
ser exposto para fora da máquina.

### 4. A receita é o contrato

O JSON da receita é o mesmo no schema, no interpretador, no painel, na
CLI, no MCP e nos compiladores. Mudar o schema muda o produto inteiro, e
por isso a validação por alvo (`validateForTarget`) existe: ela diz o que
**não** funciona antes de a receita rodar.

### 5. A mesma operação, o mesmo resultado

A camada de operações (`packages/server/src/ops.ts`) é a fonte única da
semântica. O MCP e a CLI chamam as mesmas funções, então não há dois jeitos
de fazer a mesma coisa — nem duas respostas diferentes para a mesma
pergunta. Quando um texto de erro muda, ele muda nos dois canais.

## O caminho de um dado

O clique na página vira uma receita:

```
usuário clica
   → content script (grava o evento)
   → service worker (enfileira e manda)
   → WebSocket: record.event
   → servidor: RecordingBuffer (eventos da sessão dona)
   → WebSocket: record.step + record.state (o painel conta os passos)
   → usuário para: record.stop
   → servidor: eventos → passos (RecordingBuffer.toRecipe)
   → painel: editor em JSON aberto com os passos
   → salvar: REST POST /api/recipes
   → servidor: valida contra o alvo e grava no SQLite
   → WebSocket: recipes.changed (todo mundo atualiza a lista)
```

E o caminho inverso, na execução:

```
POST /api/runs (driver: tab)
   → servidor: cria a execução e manda run.request para a extensão
   → extensão: executa um passo por vez no content script
   → servidor: run.event a cada passo (o painel acompanha)
   → extensão: run.result
   → servidor: fecha a execução e manda run.finished
```

## Decisões que já custaram tempo

Cada uma dessas nasceu de um problema concreto. Elas estão aqui para não
serem refeitas.

**A aba é um recurso único.** Duas receitas simultâneas se atropelam: o
`navigate` de uma apaga o DOM que a outra está lendo, e o passo seguinte
enxerga a página errada. Por isso as execuções na aba passam por uma fila
por extensão (`runner/tab.ts`).

**A gravação pertence a quem a começou.** Os eventos capturados por uma
extensão não podem entrar na receita de outra, senão a receita sai com
passos que nunca aconteceram. A gravação aberta pela API (sem dona) é
adotada pela primeira extensão que falar dela.

**A operação na aba vai para uma extensão só.** Mandar para todas faria
cada extensão executar na sua aba ativa — sequestrando abas de outros
navegadores. O mesmo vale para o começo e o fim da execução: o painel de
outra extensão não deve mostrar "concluída" por uma receita que rodou em
outro navegador.

**O servidor se encerra quando quem o started morre.** Um servidor órfão
segura a porta e a memória. O vigia é o líder da sessão (o shell), e o
`GRIVER_CRIADOR` cobre o caso detached, em que o pai direto morre junto e
ninguém percebe. O `griver cleanup` usa a mesma regra.

**O projeto apaga em cascata no SQLite.** `ON DELETE CASCADE` em
`recipes`, `recipe_revisions` e `schedules`: apagar um projeto leva as
receitas, e levar as revisões e os agendamentos delas.

**O `.tsbuildinfo` é o carimbo do build.** O `tsc` reescreve só as saídas
que mudaram, então comparar o fonte com um arquivo do `dist` dá falso
positivo o tempo todo. Quem precisa saber se o build está em dia compara
com o `.tsbuildinfo`.

**O build da extensão é copiado por execução.** O `dist` compartilhado é
apagado no começo de cada build, e um teste rodando com a extensão
carregada perde os arquivos no meio do caminho. Cada execução de e2e
monta a sua cópia (`--outdir`).

**O token do cliente é resolvido em cascata.** O ambiente, o arquivo
`data/token` e, por último, o próprio servidor. Um 401 relê o token em vez
de insistir com o velho: o servidor pode ter sido reiniciado com outro
token no meio do caminho.

## Referências

| Documento | O que tem |
|---|---|
| [README](../README.md) | instalação, uso, o formato da receita, a CLI, o MCP |
| [API.md](./API.md) | os endpoints, o protocolo WebSocket e as ferramentas do MCP |
| [EXTENSAO.md](./EXTENSAO.md) | o painel, a gravação e o troubleshooting da extensão |
| [AGENTES.md](./AGENTES.md) | como um agente trabalha neste repositório |
