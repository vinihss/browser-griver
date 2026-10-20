# API do Griver

Referência dos endpoints do servidor local do Griver: o que existe, como
chamar e o que cada resposta devolve.

O servidor fala três protocolos. Todos vivem no mesmo processo e na mesma
porta — exceto o MCP, que é um processo separado:

| Canal | Endereço | Quem fala com ele | Transporte |
|---|---|---|---|
| **REST** | `http://127.0.0.1:7331` | CLI, MCP, painel da extensão | HTTP/1.1 + JSON |
| **WebSocket** | `ws://127.0.0.1:7331/ws` | extensão (service worker) | JSON por frame |
| **MCP** | stdio | assistente (OpenCode) | JSON-RPC 2.0, uma mensagem por linha |

A regra da casa: **quem guarda o estado é o servidor**. A CLI, o MCP e o
painel não mexem no banco — eles falam com o REST. E quem age na aba é
a extensão, comandada pelo servidor. Por isso `page` e `record` só funcionam
com o servidor no ar **e** a extensão carregada no Chrome.

O formato da receita (o JSON que entra e sai dos endpoints de receita) está
no [README](./README.md#o-formato-da-receita).

### Como subir cada canal

```sh
griver serve        # sobe o servidor local: REST + WebSocket na mesma porta
griver-mcp          # sobe o servidor MCP por stdio (é o que o OpenCode executa)
```

Em desenvolvimento: `pnpm dev:server`. O `opencode.json` do projeto já
registra o MCP com o nome `griver` e `GRIVER_SERVER_URL` apontando para o
servidor local.

---

## Configuração

| Variável | Padrão | Para quê |
|---|---|---|
| `GRIVER_PORT` | `7331` | porta HTTP/WS |
| `GRIVER_HOST` | `127.0.0.1` | endereço de escuta (loopback) |
| `GRIVER_DATA_DIR` | `<cwd>/data` | pasta de dados (banco, token, artefatos) |
| `GRIVER_TOKEN` | — | token do servidor; o valor **ou** o caminho do arquivo que o guarda |
| `GRIVER_SERVER_URL` | `http://127.0.0.1:7331` | endereço usado pelo cliente REST (CLI, MCP) |
| `GRIVER_CDP_URL` | `http://127.0.0.1:9222` | Chrome remoto usado pelo driver `cdp` |
| `FIRECRAWL_API_KEY` | — | habilita o alvo `os` (Firecrawl) |
| `GRIVER_OPENCODE_CONFIG` | `~/.config/opencode` | onde o chat acha o OpenCode |

O token é criado no primeiro start do servidor, em `<data-dir>/token`
(24 bytes em base64url, arquivo com modo `0600`). Ele é o mesmo para a
extensão, para a CLI e para o MCP.

---

## Autenticação

Todas as rotas exigem o token, exceto três:

- `GET /api/health`
- `GET /api/info`
- `GET /api/extension-token`

O token vai em um dos dois lugares:

```http
X-Griver-Token: <token>
```

```http
Authorization: Bearer <token>
```

Sem token (ou com token errado) a resposta é `401 {"error":"token inválido"}`.

### `GET /api/extension-token`

Rota pública que entrega o token do servidor. Ela existe para a extensão
descobrir o token sozinha ao conectar.

Só responde a quem **não** é uma página da web: o Chrome não manda `Origin`
em requisições de extensão, mas sempre manda em requisições de página. E o
CORS só é liberado para origens `chrome-extension://` — uma página da web não
consegue ler a resposta mesmo que a chame.

| Situação | Resposta |
|---|---|
| Sem header `Origin` (extensão, CLI, curl) | `200 {"token":"..."}` |
| `Origin: chrome-extension://<id>` | `200 {"token":"..."}` |
| `Origin: https://exemplo.com` | `403 {"error":"o token só é entregue à extensão do Griver"}` |

### CORS

Liberado apenas para `chrome-extension://`. Preflight (`OPTIONS`) responde
`204` com `Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS`.

---

## Formato das respostas

Sucesso é sempre `200` com JSON no corpo. Um handler que não devolve nada
responde `{"ok":true}`.

Erro é sempre JSON no formato:

```json
{ "error": "mensagem legível", "detail": { "...": "detalhe opcional" } }
```

| Status | Quando acontece |
|---|---|
| `400` | corpo que não é JSON válido, ou campo obrigatório faltando |
| `401` | token ausente ou inválido |
| `403` | token pedido por uma página da web |
| `404` | rota, projeto, receita, revisão ou execução inexistente |
| `422` | receita com passos incompatíveis com o alvo pedido |
| `500` | erro interno do servidor (`detail` traz a mensagem) |
| `502` | a extensão não respondeu a um comando de página |

Rota existente chamada com o método errado também devolve `404` — o roteador
só casa método e caminho.

---

# REST

## Saúde

### `GET /api/health`

```json
{ "ok": true, "version": "0.1.0", "extensions": 1, "firecrawl": false }
```

`extensions` é o número de extensões **autenticadas** e conectadas no
WebSocket. `firecrawl` diz se a chave da API está configurada.

### `GET /api/info`

```json
{ "name": "griver", "version": "0.1.0", "extensions": 1 }
```

## Projetos

### `GET /api/projects`

```json
{ "projects": [ { "id": "…", "name": "…", "description": null, "createdAt": 1700000000000, "updatedAt": 1700000000000, "recipeCount": 3 } ] }
```

### `POST /api/projects`

```json
{ "name": "Meus scripts", "description": "opcional" }
```

Resposta: `{ "project": { … } }`. `name` é obrigatório (`400` caso contrário).

### `PATCH /api/projects/:id`

Aceita `{ "name": "…", "description": "…" }`. Resposta: `{ "project": { … } }`.

### `DELETE /api/projects/:id`

Resposta: `{ "ok": true }`.

Apagar o projeto apaga junto as receitas dele — e, em cascata, as revisões e
os agendamentos delas (`ON DELETE CASCADE` no SQLite).

## Receitas

### `GET /api/recipes?projectId=<id>`

Sem `projectId`, lista todas. Ordena pela última atualização.

```json
{ "recipes": [ { "id": "…", "projectId": "…", "name": "…", "target": "browser", "createdAt": 0, "updatedAt": 0, "stepCount": 4 } ] }
```

### `GET /api/recipes/:id`

Devolve o resumo e o corpo (os passos):

```json
{ "summary": { "id": "…", "name": "…", "target": "browser", … }, "body": { "version": 1, "steps": [ … ] } }
```

### `POST /api/recipes`

```json
{
  "projectId": "…",
  "name": "Entrar na loja",
  "target": "browser",
  "recipe": { "version": 1, "steps": [] }
}
```

Resposta: `{ "recipe": { … } }`.

| Corpo | Erro |
|---|---|
| `projectId` ou `name` faltando | `400` |
| `recipe` fora do schema (ou ausente) | `400` com `detail` = lista de problemas do Zod |
| `recipe` com passos incompatíveis com `target` | `422` com `detail` = lista de issues |

### `PATCH /api/recipes/:id`

Aceita `{ "name": "…", "target": "browser" | "os", "recipe": { … } }`.
Resposta: `{ "recipe": { … } }`.

**Toda alteração do corpo cria uma revisão automática** (a versão anterior
fica guardada com o rótulo `antes de <nome>`). Por isso o histórico existe
mesmo sem ninguém pedir revisão à mão. Mudar só o nome ou o alvo **não** cria
revisão — o corpo é que é versionado.

> Não existe endpoint de "patch de passos". Quem quer editar a lista de
> passos lê a receita, aplica a mudança e devolve o corpo inteiro no `PATCH`.
> É o que a camada de operações (`packages/server/src/ops.ts`) faz.

### `DELETE /api/recipes/:id`

Resposta: `{ "ok": true }`.

### `POST /api/recipes/:id/compile`

Gera o código da receita para um alvo. Corpo opcional:

```json
{ "target": "browser", "headed": false }
```

Resposta:

```json
{ "language": "typescript", "target": "browser", "code": "import { chromium } from 'playwright' …" }
```

`target: "os"` gera código Firecrawl; `target: "browser"` (ou omitido) gera
Playwright. `headed: true` abre o navegador com janela visível.

### `POST /api/validate`

Valida uma receita **sem** salvar.

```json
{ "recipe": { "version": 1, "steps": [] }, "target": "browser" }
```

Resposta:

```json
{
  "issues": [
    {
      "path": "steps[0]",
      "stepId": "a",
      "stepType": "select",
      "message": "O passo \"select\" não é suportado no alvo \"os\".",
      "severity": "error"
    }
  ]
}
```

`severity` é `error` ou `warning`. `path` diz onde está o passo
(`steps[0]`, `steps[2].then[0]`). `target` é opcional — sem ele, assume
`browser`.

## Revisões

### `GET /api/recipes/:id/revisions`

```json
{ "revisions": [ { "id": "…", "label": "antes de Entrar na loja", "createdAt": 1700000000000 } ] }
```

### `GET /api/recipes/:id/revisions/:revisionId`

```json
{ "revision": { "id": "…", "recipeId": "…", "body": { "version": 1, "steps": [] }, "label": "…" } }
```

### `POST /api/recipes/:id/revisions/:revisionId/restore`

Restaura a receita para aquela revisão. Resposta: `{ "recipe": { … } }`.

## Execuções

### `GET /api/runs`

As 50 execuções mais recentes.

```json
{ "runs": [ { "id": "…", "recipeId": "…", "recipeName": "…", "driver": "playwright", "status": "ok", "startedAt": 0, "endedAt": 0 } ] }
```

`status` é `queued`, `running`, `ok`, `error` ou `aborted`.

### `GET /api/runs/:id`

```json
{ "run": { … }, "log": [ { "stepId": "n1", "type": "navigate", "path": "steps[0]", "depth": 0, "status": "ok", "startedAt": 0, "endedAt": 120 } ] }
```

`log` é a lista de eventos do interpretador (um por passo executado).
`status` do passo é `running`, `ok`, `error` ou `skipped`; `path` diz onde o
passo está na receita (`steps[2].then[0]`).

### `POST /api/runs`

```json
{ "recipeId": "…", "driver": "playwright", "vars": { "usuario": "ana" } }
```

Resposta: `{ "runId": "…" }`.

| `driver` | Onde roda | Observação |
|---|---|---|
| `tab` | aba ativa da extensão | a extensão executa e reporta pelo WebSocket |
| `playwright` | servidor | headless |
| `playwright-headed` | servidor | com janela visível |
| `cdp` | servidor | conecta num Chrome com `--remote-debugging-port=9222` e reaproveita a sessão logada |
| `firecrawl` | servidor | alvo `os` |

Sem `driver`, a escolha é `firecrawl` para receita de alvo `os` e `playwright`
para as demais.

### `POST /api/runs/:id/cancel`

Resposta: `{ "ok": true }`.

## Agendamentos

### `GET /api/schedules`

```json
{ "schedules": [ { "id": "…", "recipeId": "…", "cron": "*/5 * * * *", "driver": "playwright", "enabled": true, "lastRunAt": 0, "createdAt": 0 } ] }
```

### `POST /api/schedules`

```json
{ "recipeId": "…", "cron": "*/5 * * * *", "driver": "playwright" }
```

Resposta: `{ "schedule": { … } }`.

O cron é de **cinco campos** (`minuto hora dia mês dia-da-semana`), com `*`,
listas (`1,2`), intervalos (`1-5`) e passo (`*/5`). O servidor avalia a cada
30 segundos e dispara uma vez por minuto casando.

### `DELETE /api/schedules/:id`

Resposta: `{ "ok": true }`.

## Gravação

A gravação é um caso peculiar: **quem captura os eventos é a extensão**. A
API comanda (`start`, `pause`, `resume`, `stop`, `discard`) e o estado volta
pelo WebSocket.

Todas as respostas de comando têm a mesma forma:

```json
{ "snapshot": { … }, "commanded": true, "recipe": { "version": 1, "steps": [] } }
```

- `commanded` — o comando chegou em alguma extensão. `false` significa que
  ninguém está conectado: o estado fica como estava.
- `recipe` — só no `stop`, e só quando a gravação tinha passos.

O snapshot:

```json
{
  "id": "rec_…",
  "projectId": "…",
  "status": "idle | recording | paused",
  "events": [ { "kind": "click", "selector": "#entrar", "ts": 0 } ],
  "startedAt": 0,
  "updatedAt": 0
}
```

`projectId` só aparece quando a gravação pertence a um projeto. Sem
gravação em andamento, o snapshot vem vazio (`id: ""`, `status: "idle"`,
eventos zerados).

| Endpoint | Corpo | Efeito |
|---|---|---|
| `GET /api/recording` | — | só o snapshot |
| `POST /api/recording/start` | `{ "projectId": "…" }` (opcional) | abre a gravação e manda a extensão ligar a captura |
| `POST /api/recording/pause` | — | pausa a captura |
| `POST /api/recording/resume` | — | retoma |
| `POST /api/recording/stop` | — | fecha e devolve a receita |
| `POST /api/recording/discard` | — | joga fora os passos |

`stop` espera até 3 segundos pela confirmação da extensão; sem resposta,
encerra do lado do servidor e devolve o que tem.

Cada extensão tem a sua própria gravação: os passos de uma aba não entram
na receita de outra.

## Chat

O chat usa o **servidor local do OpenCode** como motor. As rotas abaixo
conversam com ele.

### `GET /api/chat/sessions`

```json
{ "sessions": [ { "id": "…", "title": "…", "createdAt": 0 } ] }
```

### `POST /api/chat/sessions`

```json
{ "projectId": "…", "title": "opcional" }
```

Resposta: `{ "session": { … } }`.

### `GET /api/chat/sessions/:id`

```json
{ "session": { … }, "executing": false }
```

### `GET /api/chat/sessions/:id/messages`

```json
{ "messages": [ { "id": "…", "role": "assistant", "text": "…", "createdAt": 0 } ] }
```

### `POST /api/chat/sessions/:id/prompt`

```json
{ "text": "adicione um passo que extraia o preço" }
```

Resposta: `{ "ok": true }`. A resposta do assistente chega pelo WebSocket
(`chat.message`), não pela resposta HTTP.

### `POST /api/chat/sessions/:id/interrupt`

Resposta: `{ "ok": true }`.

### `POST /api/chat/sessions/:id/permission`

Responde a um pedido de permissão do assistente.

```json
{ "requestId": "…", "decision": "once | always | reject", "feedback": "opcional" }
```

Resposta: `{ "ok": true }`.

## Página

Estas rotas são operadas pela extensão: o servidor repete o comando na aba
ativa e devolve o que a extensão respondeu. Sem extensão conectada, a
resposta é `502`.

### `POST /api/page/context`

Inspeciona a aba ativa. Sem corpo.

```json
{
  "url": "https://exemplo.com",
  "title": "Exemplo",
  "documento": "mvgtgvjw-rlg9bmw9",
  "elements": [
    {
      "tag": "input",
      "type": "text",
      "text": "",
      "value": "ana",
      "placeholder": "E-mail",
      "selectors": ["#email", "input[name=email]"]
    }
  ]
}
```

`elements` traz os elementos interativos (até 120), cada um com a lista de
seletores candidatos — a mesma ordem de prioridade do gravador. `value` de
campo de senha nunca é devolvido. `documento` é a identidade do documento:
muda quando a página navega, e é o que o driver usa para saber que houve
recarga.

### `POST /api/page/click`

```json
{ "target": { "selectors": ["#entrar", "button[type=submit]"], "text": "Entrar" } }
```

`selectors` é a lista de candidatos testada **em ordem** — o primeiro que
existir na página vence. `text` é um fallback por texto.

Resposta: `{ "ok": true }`.

### `POST /api/page/fill`

```json
{ "target": { "selectors": ["#email"] }, "value": "ana@exemplo.com" }
```

Resposta: `{ "ok": true }`.

### `POST /api/page/screenshot`

Sem corpo. Resposta:

```json
{ "base64": "iVBORw0KGgo…", "mimeType": "image/png" }
```

---

# WebSocket

O WebSocket vive na mesma porta do HTTP, no caminho `/ws`:

```
ws://127.0.0.1:7331/ws
```

Ele é o canal da extensão: eventos de gravação, estado da execução, mensagens
do chat e comandos do servidor para a aba.

## Handshake

A primeira mensagem tem de ser o `hello`:

```json
{ "type": "hello", "token": "…", "clientVersion": "0.1.0" }
```

Resposta do servidor:

```json
{ "type": "hello.ok", "serverVersion": "0.1.0" }
```

Token errado:

```json
{ "type": "error", "message": "token inválido" }
```

…e a conexão é fechada. Depois do `hello`, toda mensagem que não for
autenticada recebe `{"type":"error","message":"conexão não autenticada"}`.

A extensão manda `ping` a cada 15 segundos; o servidor responde `pong`.

## Extensão → servidor

| `type` | Carga | Efeito |
|---|---|---|
| `hello` | `{ token, clientVersion? }` | autentica a conexão |
| `project.list` | — | o servidor responde `projects` |
| `project.create` | `{ name, description? }` | cria o projeto e avisa todos |
| `project.update` | `{ id, patch }` | renomeia / redescreve |
| `project.delete` | `{ id }` | apaga (em cascata) |
| `recipe.list` | `{ projectId? }` | o servidor responde `recipes` |
| `recipe.create` | `{ projectId, name, target, recipe }` | cria a receita |
| `recipe.update` | `{ id, patch }` | `{ name?, target?, recipe? }` |
| `recipe.delete` | `{ id }` | apaga |
| `record.start` | `{ projectId?, tabId? }` | a extensão assume a gravação em andamento |
| `record.pause` / `record.resume` / `record.stop` / `record.discard` | — | mexe na gravação **da própria** extensão |
| `record.event` | `{ event }` | um evento capturado na aba |
| `run.start` | `{ recipeId, driver?, vars? }` | dispara uma execução |
| `run.cancel` | `{ runId }` | cancela |
| `run.result` | `{ runId, status, events, error?, scope? }` | resultado de uma execução na aba |
| `chat.create` | `{ projectId? }` | abre conversa |
| `chat.send` | `{ sessionId, text }` | manda mensagem ao assistente |
| `chat.list` | — | pede a lista de conversas |
| `page.result` | `{ id, result }` | resposta a um `page.request` |
| `permission.reply` | `{ sessionId, requestId, reply, feedback? }` | responde permissão do assistente |
| `ping` | — | batida |

## Servidor → extensão

| `type` | Carga | Quando chega |
|---|---|---|
| `hello.ok` | `{ serverVersion }` | logo depois do `hello` |
| `error` | `{ message }` | mensagem inválida ou não autenticada |
| `pong` | — | resposta ao `ping` |
| `projects` | `{ projects }` | depois de `project.list` |
| `project` | `{ project }` | depois de criar/alterar |
| `recipes` | `{ recipes }` | depois de `recipe.list` |
| `recipe` | `{ recipe, body? }` | depois de criar |
| `projects.changed` | — | a lista de projetos mudou |
| `recipes.changed` | — | a lista de receitas mudou |
| `record.state` | `{ state, steps, projectId? }` | mudança no estado da gravação |
| `record.step` | `{ event }` | um passo foi capturado |
| `record.finished` | `{ stepCount, recipe }` | a gravação terminou — a receita vem junto |
| `record.command` | `{ action, projectId? }` | comando de gravação vindo da API |
| `run.started` | `{ run }` | uma execução começou |
| `run.event` | `{ runId, event }` | um passo da execução aconteceu |
| `run.finished` | `{ run }` | a execução terminou |
| `run.request` | `{ runId, recipeId, recipe, vars? }` | a extensão deve rodar a receita na aba |
| `chat.sessions` | `{ sessions }` | a lista de conversas mudou |
| `chat.message` | `{ sessionId, message }` | mensagem (ou fragmento) do assistente |
| `chat.tool` | `{ sessionId, toolName, state, input? }` | uma ferramenta do assistente mudou de estado |
| `chat.permission` | `{ requestId, action, resources, title? }` | o assistente pide permissão |
| `page.request` | `{ id, request }` | o servidor manda agir na aba |
| `data` | `{ id, payload }` | dado avulso |

## Correlação (requisição → resposta)

`page.request` e `page.result` são o único par com `id`:

```
servidor → extensão : {"type":"page.request","id":"req_…","request":{"action":"click","payload":{…}}}
extensão → servidor  : {"type":"page.result","id":"req_…","result":{"ok":true,"result":{…}}}
```

O servidor espera 30 segundos; depois disso a resposta é
`{"ok":false,"error":"tempo esgotado aguardando a extensão"}`.

Pela API REST só chegam `context`, `click`, `fill` e `screenshot`. O protocolo
aceita também `evaluate` — usado pelo driver durante a execução de uma
receita na aba, e não exposto por endpoint.

---

# MCP

O servidor do Griver também é um servidor MCP (`packages/server/src/mcp`).
Ele fala JSON-RPC 2.0 sobre **stdio**: uma mensagem por linha, entrada na
entrada padrão, saída na saída padrão. Log vai para a saída de erro.

Para conversar com ele:

```jsonc
// uma requisição por linha
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "recipe_list", "arguments": {} } }
```

### Métodos

| Método | Resposta |
|---|---|
| `initialize` | `{ protocolVersion, capabilities, serverInfo }` — versões aceitas: `2025-11-25`, `2025-06-18`, `2024-11-05` |
| `ping` | `{}` |
| `tools/list` | `{ tools: [ { name, description, inputSchema } ] }` |
| `tools/call` | `{ content: [ { type: "text", text: "…" } ] }` |
| `resources/list` | `{ resources: [] }` |
| `prompts/list` | `{ prompts: [] }` |

Notificação (sem `id`) não recebe resposta — e respondê-la é erro de
protocolo. Falha de ferramenta não é falha de protocolo: o texto do erro
volta em `content` com `isError: true`.

### Ferramentas

São 30 ferramentas. O cliente prefixa o nome com o do servidor
(`griver_recipe_list`, `griver_page_click`…).

| Ferramenta | O que faz | Equivalente REST |
|---|---|---|
| `recipe_list` | lista projetos e receitas | `GET /api/projects` + `GET /api/recipes` |
| `recipe_get` | lê uma receita | `GET /api/recipes/:id` |
| `recipe_new` | cria uma receita vazia | `POST /api/recipes` |
| `recipe_update` | renomeia / troca o alvo | `PATCH /api/recipes/:id` |
| `recipe_delete` | apaga a receita | `DELETE /api/recipes/:id` |
| `recipe_patch` | adiciona, altera, remove ou move passos | `GET` + `PATCH /api/recipes/:id` |
| `recipe_validate` | valida contra o alvo | `POST /api/validate` |
| `recipe_history` | lista as revisões | `GET /api/recipes/:id/revisions` |
| `recipe_restore` | restaura uma revisão | `POST …/restore` |
| `recipe_export` | gera Playwright ou Firecrawl | `POST /api/recipes/:id/compile` |
| `project_list` | lista projetos | `GET /api/projects` |
| `project_create` | cria projeto | `POST /api/projects` |
| `project_delete` | apaga projeto | `DELETE /api/projects/:id` |
| `page_context` | inspeciona a aba | `POST /api/page/context` |
| `page_click` | clica na aba | `POST /api/page/click` |
| `page_fill` | preenche um campo | `POST /api/page/fill` |
| `page_screenshot` | captura a tela | `POST /api/page/screenshot` |
| `record_state` | estado da gravação | `GET /api/recording` |
| `record_start` | começa a gravar | `POST /api/recording/start` |
| `record_pause` | pausa | `POST /api/recording/pause` |
| `record_resume` | retoma | `POST /api/recording/resume` |
| `record_stop` | para e devolve a receita | `POST /api/recording/stop` |
| `record_discard` | descarta | `POST /api/recording/discard` |
| `run` | executa uma receita | `POST /api/runs` |
| `run_list` | execuções recentes | `GET /api/runs` |
| `run_get` | uma execução e o log | `GET /api/runs/:id` |
| `run_cancel` | cancela | `POST /api/runs/:id/cancel` |
| `schedule_list` | lista agendamentos | `GET /api/schedules` |
| `schedule_add` | agenda | `POST /api/schedules` |
| `schedule_remove` | remove | `DELETE /api/schedules/:id` |

O MCP fala com o servidor pelo REST e usa o mesmo token. A resolução do token
é em cascata: `GRIVER_TOKEN` (valor ou caminho de arquivo), `<cwd>/data/token`
e, por último, `GET /api/extension-token`.

---

# Exemplos

```sh
export TOKEN=$(cat data/token)
export BASE=http://127.0.0.1:7331

# saúde
curl -s $BASE/api/health

# criar projeto e receita
curl -s -X POST $BASE/api/projects \
  -H "X-Griver-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Loja"}'

curl -s -X POST $BASE/api/recipes \
  -H "X-Griver-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{
        "projectId": "<id>",
        "name": "Extrair preço",
        "target": "browser",
        "recipe": {
          "version": 1,
          "startUrl": "https://loja.exemplo.com/produto",
          "steps": [
            { "id": "n1", "type": "navigate", "url": "https://loja.exemplo.com/produto" },
            { "id": "e1", "type": "extract", "target": { "selectors": [".preco"] }, "saveAs": "preco" }
          ]
        }
      }'

# validar sem salvar
curl -s -X POST $BASE/api/validate \
  -H "X-Griver-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"recipe":{"version":1,"steps":[]},"target":"browser"}'

# inspecionar a aba ativa (precisa da extensão conectada)
curl -s -X POST $BASE/api/page/context -H "X-Griver-Token: $TOKEN"

# executar na aba ativa
curl -s -X POST $BASE/api/runs \
  -H "X-Griver-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"recipeId":"<id>","driver":"tab"}'
```

---

# Limites conhecidos

- Só há `GET`, `POST`, `PATCH` e `DELETE`. `PUT` não existe.
- Não existe endpoint de edição parcial de passos: quem edita lê, aplica e
  salva o corpo inteiro. (`recipe_patch` do MCP faz isso por baixo.)
- As rotas de página e de gravação **não** tocam no banco — elas dependem
  da extensão. Sem extensão, a resposta é `502` (página) ou `commanded: false`
  (gravação).
- O alvo `os` (Firecrawl) não tem `select`, `hover`, `upload`, `script` nem
  `screenshot` — `POST /api/validate` aponta isso antes de a receita rodar.
- O token protege o REST, mas o servidor escuta em loopback: ele não deve
  ser exposto para fora da máquina.
- `GET /api/extension-token` entrega o token a qualquer cliente sem header
  `Origin` — isso inclui a CLI e o `curl`. Quem não deve ter o token (uma
  página da web) é barrado pelo `Origin` e pelo CORS.
