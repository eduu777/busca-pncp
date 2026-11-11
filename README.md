# 🏥 Agente Autônomo de Prospecção e Análise de Licitações da Saúde (PNCP + IA)

Serviço autônomo desenvolvido em **Node.js + TypeScript** que monitora publicações do **PNCP (Portal Nacional de Contratações Públicas)**, filtra oportunidades de fornecimento de produtos e insumos da área da saúde, extrai e higieniza o conteúdo de Editais/Termos de Referência em memória RAM (`pdf-parse`) e realiza análises estratégicas estruturadas via **LLMs (Groq, Grok/xAI, Google Gemini, OpenAI ChatGPT ou Anthropic Claude)**, persistindo tudo no **PostgreSQL** e organizando dossiês prontos para tomada de decisão.

---

## ✨ Principais Funcionalidades

* **Monitoramento Automatizado do PNCP:** Consulta periódica agendada via `node-cron` (padrão às `06:00` e `18:00`) buscando as contratações publicadas no intervalo recente (`D-1` e `D`) ou em datas customizadas.
* **Filtro Inteligente por Localidade e Escopo Comercial:**
  * Configurável por Estado (`PNCP_UF`) e Município (`PNCP_MUNICIPIO=Fortaleza` ou `TODAS`).
  * Filtra oportunidades de **fornecimento de produtos de saúde** (*medicamentos, materiais médico-hospitalares, insumos cirúrgicos/laboratoriais/odontológicos, vacinas, oxigênio, equipamentos médicos*).
  * Descarta automaticamente editais fora de escopo (como *manutenção predial/preventiva de equipamentos, desenvolvimento/licenciamento de software, obras ou concessão de cantinas*), registrando o motivo exato do descarte.
* **Extração Cirúrgica de PDF em Memória:** Baixa o binário do Edital/TR diretamente em `ArrayBuffer` (RAM), valida a assinatura `%PDF-` e aplica poda inteligente priorizando Preâmbulo, Objeto, Habilitação Técnica/ANVISA, Termo de Referência e Sanções.
* **Multi-Provedor de IA Configurável via `.env`:** Suporte nativo para alternar entre **Groq**, **Grok (xAI)**, **Google Gemini**, **ChatGPT (OpenAI)** e **Claude (Anthropic)**.
* **Organização Automática de Pastas de Prospecção Diária:**
  * Cria a pasta do dia da análise: `src/editais/Prospecção DD-MM-YYYY/`
  * Para cada edital aprovado (`Score >= SCORE_MINIMO_DOWNLOAD`), gera uma pasta individual sequencial:
    `<Município> - <Data do Processo> - <Categoria> <01, 02...>` (ex.: `Fortaleza - 16-11-2026 - medicamentos 01`, `Fortaleza - 16-11-2026 - medicamentos 02`) contendo:
    1. `edital_<ano>_<seq>.pdf` (PDF oficial do PNCP)
    2. `analise_<ano>_<seq>.txt` (Dossiê executivo em texto)
    3. `relatorio_<ano>_<seq>.html` (Relatório visual pronto para impressão/PDF)
* **Relatório Consolidado Final do Dia e Tabela de Descartados:**
  * Ao final de cada ciclo, gera `Relatorio_Final_Dia_DD-MM-YYYY.txt` e `.html` com o total de processos analisados pela IA, relação dos aprovados e **tabela detalhada dos processos descartados com o motivo do descarte**.

---

## 🗂️ Arquitetura do Projeto

```text
projeto-licitacoes/
├── src/
│   ├── config/
│   │   └── database.ts            # Pool de conexões PostgreSQL e inicialização automática do schema
│   ├── database/
│   │   └── schema.sql             # DDL: tabelas licitacoes, licitacao_analises e licitacoes_descartadas
│   ├── jobs/
│   │   └── scheduler.ts           # Agendamento via node-cron com trava de concorrência
│   ├── services/
│   │   ├── pncp.service.ts        # Consumo da API do PNCP, filtros de saúde/município e categorias
│   │   ├── pdf.service.ts         # Download em RAM, parse de PDF e poda de seções críticas
│   │   ├── ai.service.ts          # Integração multi-LLM (Groq, Grok, Gemini, ChatGPT, Claude)
│   │   └── licitacao.service.ts   # Orquestrador do pipeline, geração de dossiês e relatório diário
│   └── index.ts                   # Entrypoint da aplicação e encerramento gracioso
├── .env.example                   # Modelo de variáveis de ambiente
├── package.json
└── tsconfig.json
```

---

## 🚀 Como Configurar e Rodar

### 1. Pré-requisitos
* **Node.js** `>= 20.x`
* **PostgreSQL** `>= 14.x` (com um banco criado, ex.: `pncp_dados`)

### 2. Instalação
```bash
git clone <URL_DO_SEU_REPOSITORIO>
cd projeto-licitacoes
npm install
```

### 3. Configuração das Variáveis de Ambiente
Copie o arquivo `.env.example` para `.env` e preencha suas credenciais:
```bash
cp .env.example .env
```

No arquivo `.env`, escolha o provedor de IA desejado (`GROQ`, `GROK`, `GEMINI`, `CHATGPT` ou `CLAUDE`) e informe a respectiva chave de API:
```env
AI_PROVIDER=GROQ
GROQ_API_KEY=gsk_...

PNCP_UF=CE
PNCP_MUNICIPIO=Fortaleza   # Use "Fortaleza" ou "TODAS" para todo o estado
SCORE_MINIMO_DOWNLOAD=7
```

### 4. Comandos Disponíveis

| Comando | Descrição |
| :--- | :--- |
| `npm start` | Inicia o serviço (cria/atualiza as tabelas do banco, ativa o agendador cron e executa um ciclo imediato). |
| `npm run dev` | Inicia em modo desenvolvimento com *watch/hot-reload*. |
| `npm run consultar` | Lista no terminal todas as licitações analisadas salvas no PostgreSQL ordenadas por Score. |
| `npm run descartadas` | Exibe em formato de tabela todas as licitações descartadas pela IA e o motivo do descarte. |
| `npm run relatorio` | Regera/atualiza o relatório consolidado do dia (`Relatorio_Final_Dia_DD-MM-YYYY.txt` e `.html`). |
| `npm run typecheck` | Valida a tipagem TypeScript sem emitir arquivos. |
| `npm run build` | Compila o projeto TypeScript para JavaScript na pasta `dist/`. |

---

## 🗄️ Modelagem do Banco de Dados (PostgreSQL)

O arquivo [`src/database/schema.sql`](src/database/schema.sql) é aplicado automaticamente no boot da aplicação e estrutura 3 tabelas principais:

1. **`licitacoes`**: Metadados oficiais do PNCP, chave única composta `(cnpj_orgao, ano, sequencial)`, valores estimados, datas e link do edital.
2. **`licitacao_analises`**: Resultado completo da análise da IA (`score_oportunidade` de 1 a 10, `categoria`, `status_prospeccao`, `pasta_local`, `resumo_executivo`, `itens_principais`, `exigencias_tecnicas`, `prazos_criticos` e `riscos_identificados` em `JSONB`).
3. **`licitacoes_descartadas`**: Histórico dedicado aos editais da saúde que foram analisados pela IA mas reprovados (`Score < SCORE_MINIMO_DOWNLOAD`), armazenando o `motivo_descarte` e os `riscos_principais`.
