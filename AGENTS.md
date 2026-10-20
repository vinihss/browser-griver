# AGENTS.md

Como trabalhar neste repositório. O README diz como o Griver funciona;
isto diz como mexer nele sem quebrar o que já funciona.

## O projeto em uma linha

Griver é um automatizador de browser local: uma extensão do Chrome grava o
que você faz numa página e transforma isso numa receita (JSON) que roda na
aba atual, em um navegador headless ou no nível do sistema (Firecrawl). Um
assistente de IA edita essas receitas por MCP.

Quatro pacotes, um `@griver/core` compartilhado:

| Pacote | O que é |
|---|---|
| `packages/core` | o schema da receita, o interpretador, os compiladores e o protocolo WebSocket — **sem nenhuma dependência do Node** |
| `packages/server` | o dono do estado: REST, WebSocket, SQLite, drivers, ponte com o OpenCode e o servidor MCP |
| `packages/cli` | o `griver` do terminal |
| `packages/extension` | a extensão MV3: painel, gravador e executor na aba |

A descrição completa está em [docs/ARQUITETURA.md](./docs/ARQUITETURA.md).

## O loop de trabalho

```sh
pnpm bootstrap      # só na primeira vez (ou depois de trocar de máquina)
pnpm typecheck      # tipos de tudo, inclusive da extensão
pnpm test           # os 93 testes unitários
pnpm build          # compila core, server, cli e a extensão
pnpm e2e            # a suíte end-to-end, com Chromium de verdade
```

`pnpm bootstrap` é o caminho completo: instala, compila, linka o `griver` no
PATH e empacota a extensão. As tarefas todas morem em
`scripts/tasks.mjs` — leia esse arquivo antes de criar um script novo.

O `pnpm typecheck` não é opcional antes do build: o esbuild empacota o
bundle sem avisar sobre função inexistente, e o erro só aparece em runtime,
no navegador. O typecheck é o que pega isso.

## As cinco regras que não se quebram

1. **O servidor é dono do estado.** Receitas, execuções e conversas vivem no
   SQLite. A CLI, o MCP e o painel falam com o REST — nunca com o banco.
2. **Quem age na aba é a extensão.** O servidor manda; a extensão executa.
   `page` e `record` dependem da extensão no ar.
3. **O token protege o REST.** Todas as rotas, menos três. O CORS só libera
   origens `chrome-extension://`, e o servidor escuta em loopback.
4. **A receita é o contrato.** O mesmo schema vale para o interpretador, o
   painel, a CLI, o MCP e os compiladores. Mudar o schema muda o produto.
5. **A mesma operação, o mesmo resultado.** Quem age é
   `packages/server/src/ops.ts`. O MCP e a CLI chamam as mesmas funções —
   não há dois jeitos de fazer a mesma coisa.

## O estilo do código

O código é comentado com o **porquê**, não com o o quê. A regra da casa:
um comentário existe para responder "por que assim e não de outro jeito",
e quase sempre registra um problema que já aconteceu.

```ts
// Ruim: repete o código
// const pagina = document.querySelector(".paginacao")

// Bom: explica a decisão
// A fila espera a execução anterior terminar — ou esgotar o tempo —
// antes de mandar o comando: duas receitas simultâneas se atropelam.
```

O resto do estilo: TypeScript estrito (`noUncheckedIndexedAccess` ligado),
sem `any` implícito, módulos ESM, imports com a extensão `.js`, funções
pequenas, nomes em português do Brasil no domínio (`receita`, `gravação`,
`passo`) e em inglês no que é genérico (`server`, `driver`, `runtime`).

## O que não mexer sem saber por quê

| Coisa | Por quê |
|---|---|
| `packages/core/src/protocol/ws.ts` | é o contrato com a extensão. Mudar uma mensagem quebra a conexão sem erro de compilação |
| `packages/core/src/recipe/schema.ts` | é o contrato da receita: vale para o interpretador, o painel, a CLI, o MCP e os compiladores |
| `packages/server/src/ops.ts` | é a fonte única da semântica. Uma operação nova entra aqui, e o MCP e a CLI a ganham de graça |
| `packages/server/src/db/repo.ts` | o `ON DELETE CASCADE` do SQLite é o que apaga as receitas junto do projeto |
| `data/` | é o estado do servidor (banco, token, artefatos). Nada disso vai para o git |
| `packages/extension/dist/` | é build. Ele é apagado no começo de cada build — um e2e rodando perde os arquivos no meio |

## Antes de dizer que terminou

1. `pnpm typecheck` — sem erros
2. `pnpm test` — os 93 passando
3. Se mexeu em protocolo, extensão ou gravação: `pnpm e2e`
4. Se mexeu no schema da receita: `POST /api/validate` continua dizendo a
   verdade sobre os alvos

Um e2e que falha por uma dependência ausente (o OpenCode local, por
exemplo) deve **pular e dizer que pulou** — nunca reprovar fingindo que
testou.

## Onde as coisas estão

| Quero… | Vá em |
|---|---|
| entender uma rota | `packages/server/src/http/api.ts` |
| entender o que a extensão fala | `packages/core/src/protocol/ws.ts` e `packages/server/src/ws/gateway.ts` |
| entender a receita | `packages/core/src/recipe/schema.ts` |
| entender a execução | `packages/core/src/runtime/interpreter.ts` |
| entender a gravação | `packages/server/src/recording/buffer.ts` e `packages/extension/src/content/recorder.ts` |
| entender o chat | `packages/server/src/opencode/` |
| mexer no painel | `packages/extension/src/panel/` |
| ver os endpoints | [docs/API.md](./docs/API.md) |
| ver o mapa das telas | [docs/EXTENSAO.md](./docs/EXTENSAO.md) |
| ver o schema da receita | [docs/recipe.schema.json](./docs/recipe.schema.json) (gerado por `pnpm schema`) |
