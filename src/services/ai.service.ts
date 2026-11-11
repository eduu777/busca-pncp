import axios from "axios";
import Groq from "groq-sdk";

export type AiProviderType = "GROQ" | "GROK" | "GEMINI" | "CHATGPT" | "CLAUDE";

export interface ItemPrincipalAnalise {
  item: string;
  quantidade: string | number;
  valor_estimado?: string;
  especificacao: string;
}

export interface ModalidadeECriterioAnalise {
  sistema_registro_precos: string;
  criterio_julgamento: string;
  modo_disputa: string;
  exclusivo_me_epp: string;
  portal_compras: string;
  garantia_exigida: string;
}

export interface PrazosCriticosAnalise {
  data_envio_proposta: string | null;
  data_sessao_publica: string | null;
  prazo_impugnacao: string | null;
  prazo_entrega: string | null;
  prazo_pagamento?: string | null;
  validade_proposta?: string | null;
  vigencia_contrato?: string | null;
  local_entrega?: string | null;
  recomendacao_participacao?: string;
  dados_operacionais?: ModalidadeECriterioAnalise;
  pontos_estrategicos_proposta?: string[];
}

export interface AnaliseLicitacaoResult {
  categoria_principal: string;
  recomendacao_participacao: string;
  resumo_executivo: string;
  dados_operacionais: ModalidadeECriterioAnalise;
  itens_principais: ItemPrincipalAnalise[];
  exigencias_tecnicas: string[];
  prazos_criticos: PrazosCriticosAnalise;
  score_oportunidade: number;
  justificativa_score: string;
  motivo_descarte: string;
  riscos_identificados: string[];
  pontos_estrategicos_proposta: string[];
}

export interface ContextoLicitacaoInput {
  orgaoNome: string;
  municipio: string;
  uf: string;
  modalidade: string;
  objetoCompra: string;
  valorTotalEstimado: number | null;
  dataAberturaProposta: string | null;
  dataEncerramentoProposta: string | null;
  textoEdital: string | null;
}

const DEFAULT_MODELS: Record<AiProviderType, string> = {
  GROQ: "openai/gpt-oss-120b",
  GROK: "grok-3-mini",
  GEMINI: "gemini-2.5-flash",
  CHATGPT: "gpt-4o-mini",
  CLAUDE: "claude-3-5-sonnet-latest",
};

const FALLBACK_GROQ_MODELS = [
  "openai/gpt-oss-120b",
  "qwen/qwen3.8-27b",
  "openai/gpt-oss-20b",
  "llama-3.3-70b-versatile",
];

export class AiService {
  private readonly provider: AiProviderType;
  private model: string;
  private groqClient: Groq | null = null;

  constructor() {
    this.provider = this.resolverProvider(process.env.AI_PROVIDER);
    this.model = this.resolverModeloInicial(this.provider);

    if (this.provider === "GROQ") {
      const apiKey = process.env.GROQ_API_KEY ?? process.env.GROK_API_KEY;
      if (!apiKey) {
        throw new Error(
          "[AiService] Para usar AI_PROVIDER=GROQ, configure GROQ_API_KEY no arquivo .env.",
        );
      }
      this.groqClient = new Groq({ apiKey });
    }
  }

  private resolverProvider(rawProvider?: string): AiProviderType {
    const normalizado = (rawProvider ?? "GROQ").trim().toUpperCase();

    if (normalizado === "GEMINI" || normalizado === "GOOGLE") {
      return "GEMINI";
    }
    if (normalizado === "CHATGPT" || normalizado === "OPENAI" || normalizado === "GPT") {
      return "CHATGPT";
    }
    if (normalizado === "CLAUDE" || normalizado === "ANTHROPIC") {
      return "CLAUDE";
    }
    if (normalizado === "GROK" || normalizado === "XAI") {
      // Se o usuário escreveu GROK no .env, mas a chave configurada é uma chave gsk_ da Groq (sem chave xAI),
      // usamos automaticamente o motor GROQ para evitar erro de configuração.
      const grokKey = process.env.GROK_API_KEY ?? process.env.XAI_API_KEY ?? "";
      const groqKey = process.env.GROQ_API_KEY ?? "";
      if ((!grokKey || grokKey.startsWith("gsk_")) && groqKey.startsWith("gsk_")) {
        return "GROQ";
      }
      return "GROK";
    }

    return "GROQ";
  }

  private resolverModeloInicial(provider: AiProviderType): string {
    switch (provider) {
      case "GROQ":
        return process.env.GROQ_MODEL || DEFAULT_MODELS.GROQ;
      case "GROK":
        return process.env.GROK_MODEL || DEFAULT_MODELS.GROK;
      case "GEMINI":
        return process.env.GEMINI_MODEL || DEFAULT_MODELS.GEMINI;
      case "CHATGPT":
        return process.env.OPENAI_MODEL || DEFAULT_MODELS.CHATGPT;
      case "CLAUDE":
        return process.env.CLAUDE_MODEL || DEFAULT_MODELS.CLAUDE;
    }
  }

  public getProviderName(): AiProviderType {
    return this.provider;
  }

  public getModelName(): string {
    return `${this.provider}:${this.model}`;
  }

  /**
   * Analisa os dados da licitação utilizando o provedor de IA selecionado no `.env`
   * (`GROQ`, `GROK`, `GEMINI`, `CHATGPT` ou `CLAUDE`).
   */
  public async analisarLicitacao(input: ContextoLicitacaoInput): Promise<AnaliseLicitacaoResult> {
    const { systemPrompt, userPrompt } = this.construirPrompts(input);

    let jsonContent: string;

    switch (this.provider) {
      case "GROQ":
        jsonContent = await this.chamarGroq(systemPrompt, userPrompt);
        break;
      case "GROK":
        jsonContent = await this.chamarGrokXai(systemPrompt, userPrompt);
        break;
      case "GEMINI":
        jsonContent = await this.chamarGemini(systemPrompt, userPrompt);
        break;
      case "CHATGPT":
        jsonContent = await this.chamarOpenAi(systemPrompt, userPrompt);
        break;
      case "CLAUDE":
        jsonContent = await this.chamarClaude(systemPrompt, userPrompt);
        break;
    }

    const jsonLimpo = this.extrairBlocoJson(jsonContent);
    const parsed = JSON.parse(jsonLimpo) as Partial<AnaliseLicitacaoResult>;
    return this.normalizarResultado(parsed, input);
  }

  private construirPrompts(input: ContextoLicitacaoInput): {
    systemPrompt: string;
    userPrompt: string;
  } {
    const fonteTexto = input.textoEdital
      ? `TEXTO EXTRAÍDO DO EDITAL / TERMO DE REFERÊNCIA:\n${input.textoEdital}`
      : `AVISO: O PDF do edital não pôde ser extraído. Realize a análise detalhada com base nos metadados oficiais e na descrição do objeto abaixo:\nOBJETO DA COMPRA: ${input.objetoCompra}`;

    const systemPrompt = `Você é um Consultor e Analista Sênior de Licitações Públicas da Área da Saúde (especialista na Lei 14.133/2021, regulação sanitária ANVISA, medicamentos, insumos médico-hospitalares, OPME, laboratório e equipamentos médicos).
Sua missão é analisar profundamente o edital/Termo de Referência e gerar um dossiê estratégico completo para tomada de decisão comercial.
Retorne EXCLUSIVAMENTE um objeto JSON válido seguindo estritamente esta estrutura:

{
  "categoria_principal": "Escolha UMA categoria curta em minúsculas: medicamentos | material hospitalar | equipamentos medicos | laboratorio | odontologico | oxigenio | vacinas | ambulancia | servicos hospitalares",
  "recomendacao_participacao": "PARTICIPAR | AVALIAR COM CAUTELA | NÃO RECOMENDADO (escolha um e acrescente uma frase curta do porquê)",
  "resumo_executivo": "Síntese executiva completa (3 a 5 frases): o que está sendo licitado, perfil do órgão comprador, se é Registro de Preços (SRP) ou compra imediata, volume financeiro, local/forma de execução e atratividade.",
  "dados_operacionais": {
    "sistema_registro_precos": "Sim (Ata de Registro de Preços) | Não (Contrato/Compra Direta) | Não identificado",
    "criterio_julgamento": "Ex: Menor Preço por Item / Menor Preço por Lote / Maior Desconto",
    "modo_disputa": "Ex: Aberto / Aberto e Fechado / Fechado",
    "exclusivo_me_epp": "Ex: Sim / Não (Ampla Concorrência) / Cota Reservada para ME/EPP",
    "portal_compras": "Nome do portal eletrônico onde ocorrerá a disputa e UASG (se constar)",
    "garantia_exigida": "Ex: Não exigida / 5% do valor contratual (art. 96 Lei 14.133)"
  },
  "itens_principais": [
    {
      "item": "Número e Nome do item ou lote",
      "quantidade": "Quantidade total e unidade de fornecimento",
      "valor_estimado": "Valor unitário e/ou total estimado se constar no texto, ou 'Não detalhado no trecho'",
      "especificacao": "Especificação técnica detalhada, exigência de comodato, amostra, marca de referência ou assistência técnica"
    }
  ],
  "exigencias_tecnicas": [
    "[ANVISA / REGULATÓRIO] Detalhar Registro/Notificação ANVISA, AFE (Autorização de Funcionamento), AE, CBPF, etc.",
    "[VIGILÂNCIA SANITÁRIA] Licença / Alvará Sanitário Estadual ou Municipal vigente",
    "[CAPACIDADE TÉCNICA] Atestados de capacidade técnica exigidos (quantitativos/percentuais mínimos e parcelas de maior relevância)",
    "[CONSELHO DE CLASSE / RT] Registro no CRF, CRM, COREN, CREA, CFT ou Certificado de Responsabilidade Técnica",
    "[ECONÔMICO-FINANCEIRA] Índices contábeis (LG, SG, LC >= 1), Capital Social ou Patrimônio Líquido mínimo exigido"
  ],
  "prazos_criticos": {
    "data_envio_proposta": "Data e horário limite para cadastro da proposta ou null",
    "data_sessao_publica": "Data e horário de abertura da sessão de lances ou null",
    "prazo_impugnacao": "Regra/data limite para impugnação e esclarecimentos (ex: até 3 dias úteis antes da abertura)",
    "prazo_entrega": "Prazo máximo de entrega/execução após emissão da Nota de Empenho/Ordem de Fornecimento",
    "prazo_pagamento": "Regra de pagamento (ex: até 30 dias após atesto da Nota Fiscal)",
    "validade_proposta": "Validade mínima exigida para a proposta (ex: 60 ou 90 dias)",
    "vigencia_contrato": "Prazo de vigência da Ata/Contrato (ex: 12 meses prorrogáveis)",
    "local_entrega": "Endereço ou unidade hospitalar/almoxarifado de entrega"
  },
  "score_oportunidade": 8,
  "justificativa_score": "Análise crítica e fundamentada da nota atribuída (1 a 10), avaliando clareza técnica, valor financeiro, prazo logístico de entrega, exigências de habilitação e risco de inadimplência/execução.",
  "motivo_descarte": "Explicação direta e objetiva das principais desvantagens, barreiras ou motivos que justificariam descartar ou não participar deste edital (ex: objeto de cantina/alimentação fora do escopo médico, exigência técnica restritiva, baixo valor, prazo exíguo).",
  "riscos_identificados": [
    "Lista detalhada de riscos operacionais, logísticos, financeiros, multas severas ou exigências restritivas"
  ],
  "pontos_estrategicos_proposta": [
    "Recomendações práticas para o setor de licitação: documentos para separar com antecedência, dúvidas que merecem pedido de esclarecimento/impugnação, atenção a amostras ou marcas."
  ]
}

Regras obrigatórias:
1. "score_oportunidade" DEVE ser um número inteiro de 1 a 10.
2. REGRA CRÍTICA DE ESCOPO COMERCIAL (DESCARTE OBRIGATÓRIO): Nosso foco exclusivo é FORNECIMENTO / VENDA DE PRODUTOS E INSUMOS DE SAÚDE (medicamentos, materiais médico-hospitalares, insumos cirúrgicos/laboratoriais/odontológicos, correlatos, vacinas, oxigênio e venda de equipamentos).
   Portanto, se o objeto principal da licitação for:
   - Manutenção preventiva ou corretiva de equipamentos, calibração ou assistência técnica;
   - Sistemas informatizados, software, licenciamento de TI, prontuário eletrônico ou suporte de TI;
   - Obras de engenharia, reformas prediais, pintura ou manutenção predial;
   - Concessão de cantina, food truck, alimentação preparada ou lavanderia/limpeza;
   Você DEVE atribuir "score_oportunidade" entre 1 e 3, definir "recomendacao_participacao" como "NÃO RECOMENDADO" e explicar claramente no "motivo_descarte" que se trata de prestação de serviço/manutenção/sistema fora do escopo de fornecimento de produtos.
3. Extraia datas, valores, nomes de portais e números de itens reais presentes no texto.
4. Responda apenas em português do Brasil e produza SOMENTE o objeto JSON puro.`;

    const userPrompt = `METADADOS OFICIAIS DA LICITAÇÃO NO PNCP:
- Órgão Comprador: ${input.orgaoNome}
- Município / UF: ${input.municipio} - ${input.uf}
- Modalidade: ${input.modalidade}
- Valor Total Estimado: ${input.valorTotalEstimado !== null ? `R$ ${input.valorTotalEstimado.toFixed(2)}` : "Não informado / Orçamento Sigiloso"}
- Data Abertura Proposta: ${input.dataAberturaProposta ?? "Não informada"}
- Data Encerramento Proposta: ${input.dataEncerramentoProposta ?? "Não informada"}
- Objeto (API): ${input.objetoCompra}

${fonteTexto}`;

    return { systemPrompt, userPrompt };
  }

  /**
   * 1. Provedor GROQ (via groq-sdk com fallback automático entre modelos ativos)
   */
  private async chamarGroq(systemPrompt: string, userPrompt: string): Promise<string> {
    if (!this.groqClient) {
      throw new Error("[AiService] Cliente Groq não inicializado.");
    }

    const candidatos = Array.from(new Set([this.model, ...FALLBACK_GROQ_MODELS]));
    let ultimoErro: unknown = null;
    let promptUsuarioAtual = userPrompt;

    for (const modeloAtual of candidatos) {
      try {
        const completion = await this.groqClient.chat.completions.create({
          model: modeloAtual,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: promptUsuarioAtual },
          ],
        });

        const content = completion.choices[0]?.message?.content;
        if (!content) {
          throw new Error("Resposta vazia retornada pelo modelo Groq.");
        }

        this.model = modeloAtual;
        return content;
      } catch (error) {
        ultimoErro = error;
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes("model_not_found") ||
          message.includes("does not exist") ||
          message.includes("rate_limit_exceeded") ||
          message.includes("Request too large") ||
          message.includes("413") ||
          message.includes("429")
        ) {
          console.warn(
            `[AiService] Limite/indisponibilidade no modelo "${modeloAtual}". Alternando automaticamente para o próximo modelo...`,
          );
          if (promptUsuarioAtual.length > 10_000) {
            promptUsuarioAtual = promptUsuarioAtual.slice(0, 10_000);
          }
          continue;
        }
        throw error;
      }
    }

    throw ultimoErro;
  }

  /**
   * 2. Provedor GROK / xAI (`https://api.x.ai/v1/chat/completions`)
   */
  private async chamarGrokXai(systemPrompt: string, userPrompt: string): Promise<string> {
    const apiKey = process.env.GROK_API_KEY ?? process.env.XAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "[AiService] Para usar AI_PROVIDER=GROK (xAI), configure GROK_API_KEY no arquivo .env.",
      );
    }

    const response = await axios.post<{
      choices?: Array<{ message?: { content?: string } }>;
    }>(
      "https://api.x.ai/v1/chat/completions",
      {
        model: this.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 60_000,
      },
    );

    const content = response.data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("[AiService] Resposta vazia retornada pela API do Grok (xAI).");
    }
    return content;
  }

  /**
   * 3. Provedor GOOGLE GEMINI (`https://generativelanguage.googleapis.com/v1beta/models/...`)
   */
  private async chamarGemini(systemPrompt: string, userPrompt: string): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "[AiService] Para usar AI_PROVIDER=GEMINI, configure GEMINI_API_KEY no arquivo .env.",
      );
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await axios.post<{
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    }>(
      url,
      {
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: userPrompt }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 60_000,
      },
    );

    const content = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) {
      throw new Error("[AiService] Resposta vazia retornada pela API do Google Gemini.");
    }
    return content;
  }

  /**
   * 4. Provedor CHATGPT / OPENAI (`https://api.openai.com/v1/chat/completions`)
   */
  private async chamarOpenAi(systemPrompt: string, userPrompt: string): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "[AiService] Para usar AI_PROVIDER=CHATGPT, configure OPENAI_API_KEY no arquivo .env.",
      );
    }

    const response = await axios.post<{
      choices?: Array<{ message?: { content?: string } }>;
    }>(
      "https://api.openai.com/v1/chat/completions",
      {
        model: this.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 60_000,
      },
    );

    const content = response.data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("[AiService] Resposta vazia retornada pela API da OpenAI (ChatGPT).");
    }
    return content;
  }

  /**
   * 5. Provedor CLAUDE / ANTHROPIC (`https://api.anthropic.com/v1/messages`)
   */
  private async chamarClaude(systemPrompt: string, userPrompt: string): Promise<string> {
    const apiKey = process.env.CLAUDE_API_KEY ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "[AiService] Para usar AI_PROVIDER=CLAUDE, configure CLAUDE_API_KEY no arquivo .env.",
      );
    }

    const response = await axios.post<{
      content?: Array<{ type?: string; text?: string }>;
    }>(
      "https://api.anthropic.com/v1/messages",
      {
        model: this.model,
        max_tokens: 4096,
        temperature: 0.2,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: userPrompt,
          },
        ],
      },
      {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: 60_000,
      },
    );

    const textBlock = response.data.content?.find((c) => c.type === "text")?.text;
    if (!textBlock) {
      throw new Error("[AiService] Resposta vazia retornada pela API da Anthropic (Claude).");
    }
    return textBlock;
  }

  /**
   * Remove cercas markdown (```json ... ```) caso algum provedor as inclua ao redor do JSON.
   */
  private extrairBlocoJson(texto: string): string {
    const limpo = texto.trim();
    const matchBloco = /```(?:json)?\s*([\s\S]*?)```/i.exec(limpo);
    if (matchBloco?.[1]) {
      return matchBloco[1].trim();
    }
    const primeiroBrace = limpo.indexOf("{");
    const ultimoBrace = limpo.lastIndexOf("}");
    if (primeiroBrace !== -1 && ultimoBrace > primeiroBrace) {
      return limpo.slice(primeiroBrace, ultimoBrace + 1);
    }
    return limpo;
  }

  /**
   * Valida e normaliza todos os campos do JSON retornado pelo LLM,
   * garantindo integridade de tipos e limites antes de persistir no PostgreSQL.
   */
  private normalizarResultado(
    raw: Partial<AnaliseLicitacaoResult>,
    input: ContextoLicitacaoInput,
  ): AnaliseLicitacaoResult {
    const scoreBruto = Number(raw.score_oportunidade);
    let scoreValido = Number.isFinite(scoreBruto)
      ? Math.min(10, Math.max(1, Math.round(scoreBruto)))
      : 5;

    // Trava de segurança determinística: se o objeto da compra for manutenção de equipamentos,
    // sistemas/software/TI, obras/reformas ou cantina, força score <= 2 (Descartada)
    const regexForaEscopo =
      /\b(manuten[cç][aã]o\s+(?:preventiva|corretiva|predial|de\s+equipamentos?)|calibra[cç][aã]o\s+e\s+ensaios|desenvolvimento\s+de\s+sistema|licen[cç]a\s+de\s+software|loca[cç][aã]o\s+de\s+software|sistema\s+informatizado|cess[aã]o\s+de\s+uso\s+onerosa|food\s*truck|ramo\s+de\s+cantina|reforma\s+e\s+amplia[cç][aã]o)\b/i;

    const foraDoEscopoDetectado = regexForaEscopo.test(input.objetoCompra);
    if (foraDoEscopoDetectado && scoreValido > 3) {
      scoreValido = 2;
    }

    const recomendacaoPadrao =
      scoreValido >= 7
        ? "PARTICIPAR - Oportunidade com boa relação de retorno e aderência."
        : scoreValido >= 5
          ? "AVALIAR COM CAUTELA - Verificar barreiras técnicas e margem antes de disputar."
          : "NÃO RECOMENDADO - Alto risco ou baixa atratividade comercial.";

    const recomendacaoParticipacao =
      typeof raw.recomendacao_participacao === "string" &&
      raw.recomendacao_participacao.trim().length > 0
        ? raw.recomendacao_participacao.trim()
        : recomendacaoPadrao;

    const opsRaw = raw.dados_operacionais;
    const dadosOperacionais: ModalidadeECriterioAnalise = {
      sistema_registro_precos: String(opsRaw?.sistema_registro_precos ?? "Não identificado"),
      criterio_julgamento: String(opsRaw?.criterio_julgamento ?? "Menor Preço"),
      modo_disputa: String(opsRaw?.modo_disputa ?? "Não informado"),
      exclusivo_me_epp: String(opsRaw?.exclusivo_me_epp ?? "Não informado"),
      portal_compras: String(opsRaw?.portal_compras ?? "Não informado"),
      garantia_exigida: String(opsRaw?.garantia_exigida ?? "Não informada"),
    };

    const itensPrincipais: ItemPrincipalAnalise[] = Array.isArray(raw.itens_principais)
      ? raw.itens_principais.map((i) => ({
          item: String(i?.item ?? "Item não especificado"),
          quantidade: i?.quantidade ?? "Não informada",
          valor_estimado: String(i?.valor_estimado ?? "Não informado"),
          especificacao: String(i?.especificacao ?? ""),
        }))
      : [];

    const exigenciasTecnicas: string[] = Array.isArray(raw.exigencias_tecnicas)
      ? raw.exigencias_tecnicas.map((e) => String(e))
      : [];

    const riscosIdentificados: string[] = Array.isArray(raw.riscos_identificados)
      ? raw.riscos_identificados.map((r) => String(r))
      : [];

    const pontosEstrategicos: string[] = Array.isArray(raw.pontos_estrategicos_proposta)
      ? raw.pontos_estrategicos_proposta.map((p) => String(p))
      : [];

    const prazosRaw = raw.prazos_criticos;
    const prazosCriticos: PrazosCriticosAnalise = {
      data_envio_proposta: prazosRaw?.data_envio_proposta ?? input.dataEncerramentoProposta ?? null,
      data_sessao_publica: prazosRaw?.data_sessao_publica ?? input.dataEncerramentoProposta ?? null,
      prazo_impugnacao: prazosRaw?.prazo_impugnacao ?? null,
      prazo_entrega: prazosRaw?.prazo_entrega ?? null,
      prazo_pagamento: prazosRaw?.prazo_pagamento ?? null,
      validade_proposta: prazosRaw?.validade_proposta ?? null,
      vigencia_contrato: prazosRaw?.vigencia_contrato ?? null,
      local_entrega: prazosRaw?.local_entrega ?? null,
      recomendacao_participacao: recomendacaoParticipacao,
      dados_operacionais: dadosOperacionais,
      pontos_estrategicos_proposta: pontosEstrategicos,
    };

    const categoriaPrincipal =
      typeof raw.categoria_principal === "string" && raw.categoria_principal.trim().length > 0
        ? raw.categoria_principal
            .trim()
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[\\/:*?"<>|]/g, "")
        : "";

    const rawMotivo = typeof raw.motivo_descarte === "string" ? raw.motivo_descarte.trim() : "";
    const motivoInvalido =
      !rawMotivo || /^aprovad[oa]/i.test(rawMotivo) || rawMotivo.length < 10;

    const motivoDescarte = foraDoEscopoDetectado && motivoInvalido
      ? "Descartado: Objeto refere-se a prestação de serviços de manutenção de equipamentos, sistemas/software ou concessão, fora do escopo de fornecimento de produtos de saúde."
      : !motivoInvalido
        ? rawMotivo
        : `${typeof raw.justificativa_score === "string" ? raw.justificativa_score.trim() : "Score abaixo do mínimo exigido."} | Principais barreiras/riscos: ${riscosIdentificados.slice(0, 2).join("; ") || "Baixa aderência comercial."}`;

    return {
      categoria_principal: categoriaPrincipal,
      recomendacao_participacao: recomendacaoParticipacao,
      resumo_executivo:
        typeof raw.resumo_executivo === "string" && raw.resumo_executivo.trim().length > 0
          ? raw.resumo_executivo.trim()
          : `Contratação pública referente a: ${input.objetoCompra}`,
      dados_operacionais: dadosOperacionais,
      itens_principais: itensPrincipais,
      exigencias_tecnicas: exigenciasTecnicas,
      prazos_criticos: prazosCriticos,
      score_oportunidade: scoreValido,
      justificativa_score:
        typeof raw.justificativa_score === "string" && raw.justificativa_score.trim().length > 0
          ? raw.justificativa_score.trim()
          : "Score atribuído com base nas informações disponíveis do objeto.",
      motivo_descarte: motivoDescarte,
      riscos_identificados: riscosIdentificados,
      pontos_estrategicos_proposta: pontosEstrategicos,
    };
  }
}
