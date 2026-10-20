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

```
+------------------------+     +---------------------------+
|   Lateral (Side Panel) |     |   Lateral (Side Panel)  |
+------------------------+     +---------------------------+
|                        |     |                           |
|  ✅ PROJETOS           |     |  📝 RECEITAS (auto-open)  |
|  - Lista de projetos   |     |  - Botão "Voltar"         |
|  - Criar novo          |     |  - Botão "Nova receita"   |
|  - Excluir           --->   - Lista de receitas      |
|                        |     |  - Editor de código       |
+------------------------+     +---------------------------+
|                        |     |                           |
|  🎤 GRAVAR             |     |  🤖 CHAT                    |
|  - Iniciar gravação   |     |  - Conversas por projeto   |
|  - Pausar/Retomar     |     |  - Enviar mensagens       |
|  - Parar             ---> |                           |
+------------------------+     +---------------------------+
|                        |     |                           |
|  💬 CHAT               |     |  ⚙️ AJUSTES                |
|  - Sessões por projeto|     |  - Endereço do servidor    |
|  - Enviar mensagens   |     |  - Token de autenticação  |
|  - Ferramentas IA     --->|                           |
+------------------------+     +---------------------------+

```

### Fluxo de Navegação:

1. **Abrir extensão** → Tela "Projetos" é exibida automaticamente
2. **Clique em um projeto** → Navegação automática para tela de Receitas
3. **Na tela de Receitas**:
   - Topo: "Voltar para projetos" + "Nova receita"
   - Meio: Lista de receitas do projeto + Editor
   - Rodapé: Botões de ação (Salvar, Validar, Executar)
4. **Clique "Voltar para projetos"** → Retorna à tela de Projetos

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

### 2. **Criando um Novo Projeto**

1. Clique no ícone do Griver para abrir o painel
2. Vá para a aba "Projetos" (abre por padrão)
3. Clique em "Criar novo projeto"
4. Digite um nome e confirme
5. O projeto será criado e selecionado automaticamente

### 3. **Gravando uma Receita**

1. Selecione ou crie um projeto
2. Clique na aba "Gravar" (ou a extensão navegará automaticamente se não houver projeto selecionado)
3. Clique em "Gravar" para iniciar a gravação
4. Interaja com a página web (cliques, preenchimentos, navegações)
5. Clique em "Pausar" ou "Parar" quando terminar
6. A receita será salva automaticamente e disponível na aba "Receitas"

### 4. **Criando uma Receita do Zero**

1. Certifique-se de que um projeto está selecionado
2. Na tela de Receitas, clique em "Nova receita"
3. Digite o nome da receita e confirme
4. O editor de código será aberto
5. Escreva os passos da receita em JavaScript/TypeScript
6. Salve a receita

### 5. **Executando uma Receita**

1. Selecione um projeto e uma receita
2. Na tela de Receitas, clique em "Executar aqui"
   - Executa na aba atual do navegador
3. Ou clique em "Executar headless"
   - Executa no servidor (Firecrawl para OS, Playwright para browser)
4. Visualize os resultados na aba de execuções

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
```

O teste confere header, abas, avisos, carregamento automático dos projetos e
a navegação projeto → receitas → voltar, além de falhar se aparecer qualquer
erro de runtime no console do painel.

### Projetos não carregam

1. Verifique se o servidor tem projetos cadastrados
2. Certifique-se de estar conectado ao servidor correto
3. Tente recarregar a página do painel

---

## 🧭 Navegação entre telas

```
Projetos  ──clica no projeto──▶  Receitas  ──"Voltar para projetos"──▶  Projetos
   ▲                                                                    │
   └──────────────────────── "Projetos" na barra de abas ────────────────┘
```

A tela de receitas **não tem aba fixa** na barra. Ela é aberta ao clicar num
projeto e o botão "Voltar para projetos" retorna para a lista. Isso evita a
confusão de uma aba "Receitas" que não sabe qual projeto está selecionado.

---

## 📞 Suporte

Para mais informações, consulte:
- O código fonte em `packages/extension/src/`
- A API do servidor em `packages/server/src/`
- As issues no repositório GitHub