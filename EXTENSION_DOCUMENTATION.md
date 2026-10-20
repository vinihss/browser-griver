# Griver - Extensão de Automação de Browser

## Visão Geral

O **Griver** é uma extensão Chrome para automação local de browser que permite gravar ações, criar receitas reutilizáveis e conversar com um assistente de IA. A extensão se conecta a um servidor backend local que gerencia projetos, receitas e execuções.

---

## 📋 Funcionalidades Principais

### 1. **Gerenciamento de Projetos**
- Criar, listar e excluir projetos
- Cada projeto pode ter múltiplas receitas associadas
- Projetos são salvos no servidor backend

### 2. **Gravação de Ações**
- Gravar interações com páginas web (cliques, preenchimentos, navegações)
- Gravadores podem ser pausados e retomados
- Gravações geram receitas automaticamente

### 3. **Sistema de Receitas**
- Criar receitas do zero ou a partir de gravações
- Editor de receitas com suporte a JavaScript/TypeScript
- Validar receitas para o target (browser ou OS)
- Executar receitas na aba atual ou no servidor

### 4. **Execução de Receitas**
- Executar na aba ativa do navegador (CDP/Playwright)
- Executar no servidor (Firecrawl para targets OS)
- Visualizar eventos e resultados da execução

### 5. **Chat com Assistente de IA**
- Conversas integradas com OpenCode
- Ferramentas disponíveis durante a conversa
- Histórico de mensagens por projeto

### 6. **Configurações**
- Endereço do servidor (padrão: http://127.0.0.1:7331)
- Token de autenticação
- Configurações de gravação e execução

---

## 🗺️ Mapa de Telas

O painel lateral tem **uma tela por vez**, alternada pelos botões do cabeçalho.
A gravação acontece **dentro da página**, num overlay injetado.

```
┌────────────────────────────────────┐
│ [+]              ☰  ✦  ⚙  Connection│  ← cabeçalho
├────────────────────────────────────┤
│ RECEITAS                    [● Gravar]│
│ ┌────────────────────────────────┐ │
│ │ Carregar meus emails        ✎ ▶│ │  ← ✎ editar · ▶ executar
│ │ Script 2                    ✎ ▶│ │
│ └────────────────────────────────┘ │
│                                    │
│ [textarea com o JSON da receita]   │  ← só ao selecionar uma
│ [Salvar][Validar][Executar][...]  │
└────────────────────────────────────┘
```

```
┌─────────────────────────────────────────────────────────┐
│  ⏺ ⏸ ⏹              Cancel  Confirm     ← barra flutuante │
│                                                         │
│                            ┌───────────────────────┐    │
│                            │ Steps            [✎]  │    │
│                            │ 1. navigate           │    │
│                            │ 2. click #email        │    │
│                            │ [Cancel]        [Save] │    │
│                            └───────────────────────┘    │
└─────────────────────────────────────────────────────────┘
       ↑ este overlay vive NA PÁGINA, não no painel
```

### Fluxo de Navegação:

1. **Abrir extensão** → a tela de Receitas aparece com a lista carregada do servidor
2. **☰ / ✦ / ⚙** no cabeçalho → alterna entre Receitas, Chat e Ajustes
3. **✎ numa receita** → carrega a receita no editor (JSON) abaixo da lista
4. **▶ numa receita** → executa na aba atual
5. **+ no cabeçalho** → abre o modal "Add New Script" (Name + URL)

### Fluxo de gravação:

1. **● Gravar** no painel → o overlay aparece na aba ativa
2. **Interaja com a página** → os passos aparecem na lista "Steps" do overlay
3. **⏸ / ⏺** na barra → pausa e retoma a captura
4. **⏹ Stop** → a gravação para e a receita fica pronta
5. **✎** ao lado de "Steps" → abre o rascunho no editor do painel
6. **Save** no overlay → abre o modal "Add New Script" com a URL da gravação

> O overlay sobrevive a navegações: o estado da gravação mora no service
> worker, não na página. É por isso que o primeiro passo de uma receita — que
> quase sempre é uma navegação — não se perde.

---

## 🛠️ Rotinas e Procedimentos

### 1. **Primeira Configuração**

```bash
# 1. Iniciar o servidor
bash start-all.sh

# 2. Instalar a extensão no Chrome:
#   - Acesse chrome://extensions/
#   - Ative "Modo de desenvolvedor"
#   - Clique em "Carregar extensão não compactada"
#   - Selecione: packages/extension/dist/

# 3. Conectar a extensão:
#   - Clique no ícone do Griver
#   - O painel abrirá e conectará automaticamente
#   - Token será salvo no armazenamento local
```

### 2. **Criando um Novo Script**

1. Clique no ícone do Griver para abrir o painel
2. Clique no botão **+** do cabeçalho
3. Preencha **Name** e **URL**
   - a URL vira o `startUrl` da receita — a página onde ela começa
4. Clique em **Save**
5. A receita aparece na lista de Receitas

A receita é criada no projeto ativo; se não houver nenhum, o Griver usa um
projeto padrão chamado "Meus scripts" (criado uma única vez).

### 3. **Gravando uma Receita**

1. Abra a página que você quer automatizar
2. No painel, clique em **● Gravar**
3. O overlay aparece **dentro da página**:
   - a barra superior tem Record/Pause, Stop, Cancel e Confirm
   - o painel "Steps" lista os passos capturados em tempo real
4. Interaja com a página (cliques, preenchimentos, navegações)
   - a gravação sobrevive a navegações: o primeiro passo é a URL inicial
5. Clique em **⏹ Stop** quando terminar
6. Clique em **✎** ao lado de "Steps" para abrir o rascunho no editor do painel
7. Ajuste o JSON se quiser e clique em **Salvar**
8. O modal "Add New Script" abre — preencha o **Name** e confirme

### 4. **Criando uma Receita do Zero**

1. Clique no botão **+** do cabeçalho
2. Preencha **Name** e **URL**
3. Clique em **Save**
4. A receita é criada vazia e o editor de código abre com o JSON
5. Escreva os passos da receita
6. Clique em **Salvar** para gravar no servidor

### 5. **Executando uma Receita**

1. Na lista de Receitas, clique em **▶** na linha da receita
   - executa na aba atual do navegador
2. Ou selecione a receita (✎) e use os botões do editor
   - "Executar aqui" — aba atual
   - "Executar headless" — no servidor (Firecrawl para OS, Playwright para browser)
   - "Validar" — confere os passos contra o alvo
   - "Exportar" — copia o código gerado
   - "Remover" — apaga a receita

### 5. **Validando uma Receita**

1. Na tela de Receitas, escreva ou edite a receita
2. Clique em "Validar"
3. Verifique os erros/warnings no painel inferior
3. Corrija quaisquer problemas e valide novamente

### 6. **Gerenciando Receitas**

- **Editar**: Modifique o código no editor e clique em "Salvar"
- **Remover**: Selecione a receita e clique no botão "Remover"
- **Exportar**: Clique em "Exportar" para copiar o código compilado

---

## 📁 Estrutura de Arquivos

```
/home/vinicius/browser-griver/
├── packages/                  # Workspace pnpm
│   ├── extension/             # Extensão Chrome
│   │   ├── src/               # Fonte TypeScript
│   │   └── dist/              # Arquivos compilados
│   ├── server/                # Backend Node.js
│   │   └── src/               # Fonte TypeScript
│   └── core/                  # Biblioteca compartilhada
├── start-all.sh               # Script para iniciar tudo
├── griver-extension.zip       # Extensão compactada
└── EXTENSION_DOCUMENTATION.md # Esta documentação
```

---

## 🔧 Desenvolvimento

### Build da Extensão

```bash
# Build apenas da extensão
pnpm --filter @griver/extension run build

# Build completo (core + extension + server)
pnpm build
```

### Executar Servidor

```bash
# Apenas o servidor
pnpm dev:server

# Ou usar o script start-all.sh
bash start-all.sh
```

### Testar Conexão

```bash
# Verificar se servidor está rodando
curl http://127.0.0.1:7331/api/health

# Expected: {"ok":true,"version":"0.1.0",...}
```

---

## 🐛 Solução de Problemas

### Erro: "Não foi possível conectar ao servidor"

1. Verifique se o servidor está rodando (`http://127.0.0.1:7331/api/health`)
2. Certifique-se de que o Chrome tem permissão para acessar a porta
3. Tente clicar em "Tentar novamente" no aviso de erro

### Extensão não carrega

1. Verifique se o ZIP foi criado corretamente
2. Certifique-se de estar carregando a pasta `dist/`, não o ZIP
3. Verifique o console do Chrome (F12) por erros

### Erro: "onRuntimeMessage is not defined" / "header is not defined"

O painel abriu, mas o JavaScript quebrou na hora de renderizar.

**Causa:** alguma função chamada em `app.ts` deixou de existir no arquivo — o
`esbuild` empacota o bundle sem avisar, e o erro só aparece em runtime.

**Como evitar:** rode o typecheck antes de buildar. Ele acusa função
inexistente, símbolo não importado e variável fora de escopo:

```bash
pnpm --filter @griver/extension exec tsc --noEmit -p tsconfig.json
```

O `start-all.sh` já executa esse passo automaticamente (etapa `1b️⃣`).

**Verificação completa do painel** (roda em um Chrome real via Playwright):

```bash
pnpm run dev:server              # em um terminal
pnpm run test:e2e:verifica       # em outro
pnpm run test:e2e:overlay        # o overlay dentro da página
pnpm run test:e2e:modal          # o modal Add New Script
```

O `verifica` confere header, botões de ação, título truncado, o modal e a
alternância com o Chat. O `overlay` cobre o ponto mais arriscado: a gravação
precisa sobreviver a uma navegação.

### Overlay não aparece na página

1. Confirme que a página é `http`/`https`/`file` — `chrome://` não aceita
   extensão
2. Olhe o console da página (F12): erros de CSP aparecem lá
3. Recarregue a aba — o content script só é injetado em páginas já abertas
   quando a extensão é recarregada

### Passos duplicados na gravação

Cada evento é contado uma vez. Se aparecer duplicado, são duas extensões
conectadas ao mesmo servidor: feche as outras abas do Chrome.

### Receita não aparece na lista

1. A lista mostra **todas** as receitas do servidor, sem filtro de projeto
2. Se o servidor estiver fora do ar, o painel mostra o aviso de conexão
3. Clique em **☰** (Receitas) para voltar à lista

---

## 🧭 Navegação entre telas

```
┌──────────────────────────────────────────┐
│ [+]            ☰ Receitas  ✦ Chat  ⚙ Ajustes │
└──────────────────────────────────────────┘
      │            │          │         │
      ▼            ▼          ▼         ▼
   modal      lista de     conversa   servidor
  Add New     receitas                 e token
   Script
```

O painel tem **uma tela por vez**, alternada pelos botões do cabeçalho. O
`+` abre o modal; o **☰** traz a lista de receitas; o **✦** o chat; o **⚙** os
ajustes. O botão **● Gravar** fica na seção de Receitas.

A gravação não vive no painel: ela vira um **overlay dentro da página**, e é
de lá que se controla a captura.

---

## 📞 Suporte

Para mais informações, consulte:
- O código fonte em `packages/extension/src/`
- A API do servidor em `packages/server/src/`
- As issues no repositório GitHub