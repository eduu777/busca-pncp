import fs from "fs";
import path from "path";
import { PoolClient } from "pg";
import { getDbClient } from "../config/database";
import { AiService, AnaliseLicitacaoResult } from "./ai.service";
import { PdfService } from "./pdf.service";
import { PncpContratacaoItem, PncpService } from "./pncp.service";

export interface EstatisticasExecucao {
  paginasConsultadas: number;
  licitacoesInspecionadas: number;
  filtradasSaude: number;
  jaExistentes: number;
  analisadasComSucesso: number;
  aprovadas: number;
  descartadasPelaIa: number;
  arquivosSalvosDisco: number;
  errosProcessamento: number;
}

interface RegistroAprovadoDia {
  id: number;
  municipio: string | null;
  uf: string | null;
  orgao_nome: string | null;
  ano: number;
  sequencial: number;
  categoria: string;
  valor_total_estimado: string | null;
  score_oportunidade: number;
  recomendacao_participacao: string | null;
  pasta_local: string | null;
  objeto_compra: string;
}

interface RegistroDescartadoDia {
  id: number;
  licitacao_id: number;
  municipio: string | null;
  uf: string | null;
  orgao_nome: string | null;
  cnpj_orgao: string;
  ano: number;
  sequencial: number;
  categoria: string;
  valor_total_estimado: string | null;
  score_oportunidade: number;
  motivo_descarte: string;
  objeto_compra: string;
}

export class LicitacaoService {
  private readonly pncpService: PncpService;
  private readonly pdfService: PdfService;
  private readonly aiService: AiService;
  private readonly scoreMinimoDownload: number;

  constructor(
    pncpService?: PncpService,
    pdfService?: PdfService,
    aiService?: AiService,
  ) {
    this.pncpService = pncpService ?? new PncpService();
    this.pdfService = pdfService ?? new PdfService();
    this.aiService = aiService ?? new AiService();
    this.scoreMinimoDownload = Number(process.env.SCORE_MINIMO_DOWNLOAD ?? 7);
  }

  /**
   * Formata uma data ISO (`YYYY-MM-DD...`) ou `Date` para `DD-MM-YYYY`.
   */
  private static formatarDataBr(dataInput?: string | Date | null): string {
    if (!dataInput) {
      const hoje = new Date();
      const d = String(hoje.getDate()).padStart(2, "0");
      const m = String(hoje.getMonth() + 1).padStart(2, "0");
      const y = hoje.getFullYear();
      return `${d}-${m}-${y}`;
    }

    if (dataInput instanceof Date) {
      const d = String(dataInput.getDate()).padStart(2, "0");
      const m = String(dataInput.getMonth() + 1).padStart(2, "0");
      const y = dataInput.getFullYear();
      return `${d}-${m}-${y}`;
    }

    const isoPart = dataInput.substring(0, 10);
    const partes = isoPart.split("-");
    if (partes.length === 3 && partes[0]?.length === 4) {
      return `${partes[2]}-${partes[1]}-${partes[0]}`;
    }

    return isoPart.replace(/[\\/:*?"<>|]/g, "-");
  }

  /**
   * Retorna o caminho da pasta raiz do dia da prospecção:
   * Ex: `src/editais/Prospecção 09-11-2026`
   */
  public obterPastaDiaProspeccao(dataRef: Date = new Date()): string {
    const dataDiaBr = LicitacaoService.formatarDataBr(dataRef);
    const pastaDia = path.resolve(
      __dirname,
      "..",
      "editais",
      `Prospecção ${dataDiaBr}`,
    );
    fs.mkdirSync(pastaDia, { recursive: true });
    return pastaDia;
  }

  /**
   * Verifica no PostgreSQL se a chave composta `(cnpj_orgao, ano, sequencial)` já foi processada.
   * Libera explicitamente o cliente do pool no bloco `finally`.
   */
  public async licitacaoJaProcessada(
    cnpjOrgao: string,
    ano: number,
    sequencial: number,
  ): Promise<boolean> {
    let client: PoolClient | null = null;
    try {
      client = await getDbClient();
      const query = `
        SELECT 1
        FROM licitacoes
        WHERE cnpj_orgao = $1 AND ano = $2 AND sequencial = $3
        LIMIT 1
      `;
      const result = await client.query(query, [cnpjOrgao, ano, sequencial]);
      return (result.rowCount ?? 0) > 0;
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  /**
   * Persiste de forma atômica (transação SQL):
   * 1. Metadados na tabela `licitacoes`
   * 2. Parecer completo na tabela `licitacao_analises` (com `categoria`, `status_prospeccao`, `pasta_local`)
   * 3. Caso descartada pela IA (`score < scoreMinimoDownload`), grava na tabela `licitacoes_descartadas` com o motivo claro.
   */
  public async salvarLicitacaoEAnalise(
    item: PncpContratacaoItem,
    urlEdital: string | null,
    fonteAnalise: "PDF" | "OBJETO_FALLBACK",
    analise: AnaliseLicitacaoResult,
    categoria: string,
    statusProspeccao: "APROVADA" | "DESCARTADA",
    pastaLocal: string | null,
  ): Promise<number> {
    let client: PoolClient | null = null;
    try {
      client = await getDbClient();
      await client.query("BEGIN");

      const orgaoNome =
        item.orgaoEntidade.razaoSocial ?? item.unidadeOrgao?.nomeUnidade ?? null;
      const uf = item.unidadeOrgao?.ufSigla ?? null;
      const municipio = item.unidadeOrgao?.municipioNome ?? null;

      const insertLicitacaoSql = `
        INSERT INTO licitacoes (
          cnpj_orgao,
          ano,
          sequencial,
          numero_controle_pncp,
          orgao_nome,
          uf,
          municipio,
          modalidade_nome,
          objeto_compra,
          valor_total_estimado,
          data_publicacao,
          data_abertura_proposta,
          data_encerramento_proposta,
          link_sistema_origem,
          url_edital
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
        )
        ON CONFLICT (cnpj_orgao, ano, sequencial) DO UPDATE
          SET url_edital = EXCLUDED.url_edital
        RETURNING id
      `;

      const valoresLicitacao = [
        item.orgaoEntidade.cnpj,
        item.anoCompra,
        item.sequencialCompra,
        item.numeroControlePNCP ?? null,
        orgaoNome,
        uf,
        municipio,
        item.modalidadeNome ?? null,
        item.objetoCompra ?? "",
        item.valorTotalEstimado ?? null,
        item.dataPublicacaoPncp ? new Date(item.dataPublicacaoPncp) : null,
        item.dataAberturaProposta ? new Date(item.dataAberturaProposta) : null,
        item.dataEncerramentoProposta ? new Date(item.dataEncerramentoProposta) : null,
        item.linkSistemaOrigem ?? null,
        urlEdital,
      ];

      const resLicitacao = await client.query<{ id: number }>(
        insertLicitacaoSql,
        valoresLicitacao,
      );

      const licitacaoId = resLicitacao.rows[0]?.id;
      if (!licitacaoId) {
        throw new Error("Não foi possível obter o ID da licitação inserida.");
      }

      const insertAnaliseSql = `
        INSERT INTO licitacao_analises (
          licitacao_id,
          fonte_analise,
          modelo_llm,
          categoria,
          status_prospeccao,
          pasta_local,
          data_prospeccao,
          resumo_executivo,
          itens_principais,
          exigencias_tecnicas,
          prazos_criticos,
          score_oportunidade,
          justificativa_score,
          riscos_identificados
        ) VALUES (
          $1, $2, $3, $4, $5, $6, CURRENT_DATE, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13::jsonb
        )
        ON CONFLICT (licitacao_id) DO UPDATE SET
          fonte_analise = EXCLUDED.fonte_analise,
          modelo_llm = EXCLUDED.modelo_llm,
          categoria = EXCLUDED.categoria,
          status_prospeccao = EXCLUDED.status_prospeccao,
          pasta_local = EXCLUDED.pasta_local,
          data_prospeccao = CURRENT_DATE,
          resumo_executivo = EXCLUDED.resumo_executivo,
          itens_principais = EXCLUDED.itens_principais,
          exigencias_tecnicas = EXCLUDED.exigencias_tecnicas,
          prazos_criticos = EXCLUDED.prazos_criticos,
          score_oportunidade = EXCLUDED.score_oportunidade,
          justificativa_score = EXCLUDED.justificativa_score,
          riscos_identificados = EXCLUDED.riscos_identificados
      `;

      const valoresAnalise = [
        licitacaoId,
        fonteAnalise,
        this.aiService.getModelName(),
        categoria,
        statusProspeccao,
        pastaLocal,
        analise.resumo_executivo,
        JSON.stringify(analise.itens_principais),
        JSON.stringify(analise.exigencias_tecnicas),
        JSON.stringify(analise.prazos_criticos),
        analise.score_oportunidade,
        analise.justificativa_score,
        JSON.stringify(analise.riscos_identificados),
      ];

      await client.query(insertAnaliseSql, valoresAnalise);

      if (statusProspeccao === "DESCARTADA") {
        const insertDescartadaSql = `
          INSERT INTO licitacoes_descartadas (
            licitacao_id,
            cnpj_orgao,
            ano,
            sequencial,
            orgao_nome,
            municipio,
            uf,
            categoria,
            objeto_compra,
            valor_total_estimado,
            score_oportunidade,
            motivo_descarte,
            riscos_principais,
            modelo_llm,
            data_prospeccao
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, CURRENT_DATE
          )
          ON CONFLICT (licitacao_id) DO UPDATE SET
            categoria = EXCLUDED.categoria,
            score_oportunidade = EXCLUDED.score_oportunidade,
            motivo_descarte = EXCLUDED.motivo_descarte,
            riscos_principais = EXCLUDED.riscos_principais,
            modelo_llm = EXCLUDED.modelo_llm,
            data_prospeccao = CURRENT_DATE
        `;

        await client.query(insertDescartadaSql, [
          licitacaoId,
          item.orgaoEntidade.cnpj,
          item.anoCompra,
          item.sequencialCompra,
          orgaoNome,
          municipio,
          uf,
          categoria,
          item.objetoCompra ?? "",
          item.valorTotalEstimado ?? null,
          analise.score_oportunidade,
          analise.motivo_descarte,
          JSON.stringify(analise.riscos_identificados),
          this.aiService.getModelName(),
        ]);
      } else {
        await client.query(
          "DELETE FROM licitacoes_descartadas WHERE licitacao_id = $1",
          [licitacaoId],
        );
      }

      await client.query("COMMIT");
      return licitacaoId;
    } catch (error) {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackErr) {
          console.error("[LicitacaoService] Erro ao executar ROLLBACK:", rollbackErr);
        }
      }
      throw error;
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  /**
   * Cria a pasta individual do edital dentro de `src/editais/Prospecção DD-MM-YYYY/`
   * seguindo o padrão: `<Município> - <data do processo> - <categoria> <01, 02...>`
   * Ex: `Fortaleza - 18-11-2026 - medicamentos 01`
   * Se já houver edital na mesma cidade e mesma data do processo, incrementa para `02`, `03`, etc.
   */
  private criarPastaEditalSequencial(
    municipio: string,
    dataProcessoBr: string,
    categoria: string,
  ): string {
    const pastaDia = this.obterPastaDiaProspeccao();
    const municipioLimpo = municipio.replace(/[\\/:*?"<>|]/g, "").trim();
    const categoriaLimpa = categoria.replace(/[\\/:*?"<>|]/g, "").trim();

    const prefixoCidadeData = `${municipioLimpo} - ${dataProcessoBr} - `.toLowerCase();

    const existentes = fs
      .readdirSync(pastaDia, { withFileTypes: true })
      .filter(
        (dirent) =>
          dirent.isDirectory() &&
          dirent.name.toLowerCase().startsWith(prefixoCidadeData),
      );

    let indice = existentes.length + 1;
    let nomePasta = `${municipioLimpo} - ${dataProcessoBr} - ${categoriaLimpa} ${String(indice).padStart(2, "0")}`;
    let caminhoCompleto = path.join(pastaDia, nomePasta);

    while (fs.existsSync(caminhoCompleto)) {
      indice++;
      nomePasta = `${municipioLimpo} - ${dataProcessoBr} - ${categoriaLimpa} ${String(indice).padStart(2, "0")}`;
      caminhoCompleto = path.join(pastaDia, nomePasta);
    }

    fs.mkdirSync(caminhoCompleto, { recursive: true });
    return caminhoCompleto;
  }

  /**
   * Salva na pasta `src/editais/Prospecção DD-MM-YYYY/<Municipio> - <DataProcesso> - <categoria> <01>/`:
   * 1. O PDF original do edital (já em memória)
   * 2. O Dossiê Executivo completo da análise em `.txt`
   * 3. O Relatório Visual pronto para impressão/PDF em `.html`
   */
  private salvarArquivosLocais(
    item: PncpContratacaoItem,
    urlEdital: string | null,
    bufferPdf: Buffer | null,
    analise: AnaliseLicitacaoResult,
    categoria: string,
  ): string {
    const municipio = item.unidadeOrgao?.municipioNome ?? "SemMunicipio";
    const dataProcessoBr = LicitacaoService.formatarDataBr(
      item.dataEncerramentoProposta ?? item.dataPublicacaoPncp,
    );

    const pastaDestino = this.criarPastaEditalSequencial(
      municipio,
      dataProcessoBr,
      categoria,
    );

    // 1. Grava o PDF original do Edital se disponível em memória
    if (bufferPdf) {
      const caminhoPdf = path.join(
        pastaDestino,
        `edital_${item.anoCompra}_${item.sequencialCompra}.pdf`,
      );
      fs.writeFileSync(caminhoPdf, bufferPdf);
    }

    const orgaoNome =
      item.orgaoEntidade.razaoSocial ?? item.unidadeOrgao?.nomeUnidade ?? "Órgão não informado";
    const unidadeNome = item.unidadeOrgao?.nomeUnidade ?? "Unidade não informada";
    const valorFormatado =
      item.valorTotalEstimado !== null && item.valorTotalEstimado !== undefined
        ? `R$ ${Number(item.valorTotalEstimado).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
        : "Não informado / Orçamento Sigiloso";

    const classificacaoScore =
      analise.score_oportunidade >= 8
        ? "ALTA ATRATIVIDADE (OPORTUNIDADE PRIORITÁRIA)"
        : analise.score_oportunidade >= 6
          ? "MÉDIA-ALTA ATRATIVIDADE (VIÁVEL COM ATENÇÃO)"
          : "BAIXA/MODERADA ATRATIVIDADE (ALTO RISCO OU RESTRIÇÃO)";

    const barraScore =
      "█".repeat(analise.score_oportunidade) + "░".repeat(10 - analise.score_oportunidade);

    const itensTxt =
      analise.itens_principais.length > 0
        ? analise.itens_principais
            .map(
              (it, idx) =>
                `  [${String(idx + 1).padStart(2, "0")}] ITEM / LOTE   : ${it.item}\n` +
                `       QUANTIDADE    : ${it.quantidade}\n` +
                `       VALOR ESTIM.  : ${it.valor_estimado ?? "Não detalhado"}\n` +
                `       ESPECIFICAÇÃO : ${it.especificacao}`,
            )
            .join("\n  ------------------------------------------------------------------------------\n")
        : "  Nenhum item detalhado separadamente.";

    const exigenciasTxt =
      analise.exigencias_tecnicas.length > 0
        ? analise.exigencias_tecnicas.map((ex, idx) => `  [ ] ${idx + 1}. ${ex}`).join("\n")
        : "  Nenhuma exigência técnica específica identificada.";

    const riscosTxt =
      analise.riscos_identificados.length > 0
        ? analise.riscos_identificados.map((ri, idx) => `  (!) ${idx + 1}. ${ri}`).join("\n")
        : "  Nenhum risco crítico identificado.";

    const pontosEstrategicosTxt =
      analise.pontos_estrategicos_proposta && analise.pontos_estrategicos_proposta.length > 0
        ? analise.pontos_estrategicos_proposta.map((pt, idx) => `  -> ${idx + 1}. ${pt}`).join("\n")
        : "  Revisar integralmente o Termo de Referência e anexos antes do envio da proposta.";

    const dataGeracao = new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });

    // 2. Grava o Dossiê Executivo Completo em TXT
    const conteudoTxt = [
      "================================================================================",
      "          DOSSIÊ EXECUTIVO DE ANÁLISE DE LICITAÇÃO (SAÚDE / PNCP)               ",
      "================================================================================",
      `DATA DA ANÁLISE       : ${dataGeracao}`,
      `PASTA DO PROCESSO     : ${path.basename(pastaDestino)}`,
      `CATEGORIA DETECTADA   : ${categoria.toUpperCase()}`,
      `MOTOR DE IA UTILIZADO : ${this.aiService.getModelName()}`,
      "================================================================================",
      "                       PARECER DE VIABILIDADE COMERCIAL                         ",
      "================================================================================",
      `SCORE DE OPORTUNIDADE : [${barraScore}] ${analise.score_oportunidade} / 10`,
      `CLASSIFICAÇÃO         : ${classificacaoScore}`,
      `RECOMENDAÇÃO DA IA    : ${analise.recomendacao_participacao}`,
      "",
      "JUSTIFICATIVA DO SCORE:",
      `  ${analise.justificativa_score}`,
      "",
      "================================================================================",
      "1. FICHA TÉCNICA E OPERACIONAL DO CERTAME",
      "================================================================================",
      `  Órgão Comprador       : ${orgaoNome}`,
      `  Unidade Compradora    : ${unidadeNome}`,
      `  CNPJ do Órgão         : ${item.orgaoEntidade.cnpj}`,
      `  Município / UF        : ${item.unidadeOrgao?.municipioNome ?? "N/I"} - ${item.unidadeOrgao?.ufSigla ?? "N/I"}`,
      `  Identificação PNCP    : Ano ${item.anoCompra} | Sequencial ${item.sequencialCompra} (${item.numeroControlePNCP ?? "S/N"})`,
      `  Modalidade            : ${item.modalidadeNome ?? "Pregão Eletrônico"}`,
      `  Registro de Preços    : ${analise.dados_operacionais.sistema_registro_precos}`,
      `  Critério Julgamento   : ${analise.dados_operacionais.criterio_julgamento}`,
      `  Modo de Disputa       : ${analise.dados_operacionais.modo_disputa}`,
      `  Exclusividade ME/EPP  : ${analise.dados_operacionais.exclusivo_me_epp}`,
      `  Portal de Compras     : ${analise.dados_operacionais.portal_compras}`,
      `  Garantia Exigida      : ${analise.dados_operacionais.garantia_exigida}`,
      `  Valor Total Estimado  : ${valorFormatado}`,
      `  Link Sistema Origem   : ${item.linkSistemaOrigem ?? "Não informado na API"}`,
      `  Link Edital (PNCP)    : ${urlEdital ?? "Não disponível"}`,
      "",
      "================================================================================",
      "2. RESUMO EXECUTIVO E OBJETO COMPLETO",
      "================================================================================",
      "SÍNTESE EXECUTIVA:",
      `  ${analise.resumo_executivo}`,
      "",
      "OBJETO OFICIAL (PNCP):",
      `  ${item.objetoCompra ?? ""}`,
      "",
      "================================================================================",
      "3. CRONOGRAMA, PRAZOS CRÍTICOS E CONDIÇÕES DE EXECUÇÃO",
      "================================================================================",
      `  - Abertura das Propostas    : ${item.dataAberturaProposta ?? "Não informado"}`,
      `  - Limite Envio de Proposta  : ${analise.prazos_criticos.data_envio_proposta ?? "Não informado"}`,
      `  - Data da Sessão Pública    : ${analise.prazos_criticos.data_sessao_publica ?? "Não informado"}`,
      `  - Prazo p/ Impugnação       : ${analise.prazos_criticos.prazo_impugnacao ?? "Não informado"}`,
      `  - Prazo de Entrega/Execução : ${analise.prazos_criticos.prazo_entrega ?? "Não informado"}`,
      `  - Local de Entrega          : ${analise.prazos_criticos.local_entrega ?? "Não informado"}`,
      `  - Condições de Pagamento    : ${analise.prazos_criticos.prazo_pagamento ?? "Não informado"}`,
      `  - Validade da Proposta      : ${analise.prazos_criticos.validade_proposta ?? "Não informado"}`,
      `  - Vigência Contratual/Ata   : ${analise.prazos_criticos.vigencia_contrato ?? "Não informado"}`,
      "",
      "================================================================================",
      "4. RELAÇÃO DE ITENS PRINCIPAIS / LOTES IDENTIFICADOS",
      "================================================================================",
      itensTxt,
      "",
      "================================================================================",
      "5. CHECKLIST DE HABILITAÇÃO E EXIGÊNCIAS TÉCNICAS / REGULATÓRIAS (SAÚDE)",
      "================================================================================",
      exigenciasTxt,
      "",
      "================================================================================",
      "6. MATRIZ DE RISCOS E PONTOS DE ATENÇÃO",
      "================================================================================",
      riscosTxt,
      "",
      "================================================================================",
      "7. PLANO DE AÇÃO E RECOMENDAÇÕES PARA PREPARAÇÃO DA PROPOSTA",
      "================================================================================",
      pontosEstrategicosTxt,
      "================================================================================",
    ].join("\n");

    const caminhoTxt = path.join(
      pastaDestino,
      `analise_${item.anoCompra}_${item.sequencialCompra}.txt`,
    );
    fs.writeFileSync(caminhoTxt, conteudoTxt, "utf-8");

    // 3. Grava também o Relatório Visual em HTML (leve e pronto para Imprimir / Salvar como PDF)
    const conteudoHtml = this.gerarRelatorioHtml(
      item,
      urlEdital,
      analise,
      categoria,
      valorFormatado,
      classificacaoScore,
      dataGeracao,
    );
    const caminhoHtml = path.join(
      pastaDestino,
      `relatorio_${item.anoCompra}_${item.sequencialCompra}.html`,
    );
    fs.writeFileSync(caminhoHtml, conteudoHtml, "utf-8");

    return pastaDestino;
  }

  private escaparHtml(texto: string): string {
    return texto
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  private gerarRelatorioHtml(
    item: PncpContratacaoItem,
    urlEdital: string | null,
    analise: AnaliseLicitacaoResult,
    categoria: string,
    valorFormatado: string,
    classificacaoScore: string,
    dataGeracao: string,
  ): string {
    const orgaoNome =
      item.orgaoEntidade.razaoSocial ?? item.unidadeOrgao?.nomeUnidade ?? "Órgão não informado";
    const corScore =
      analise.score_oportunidade >= 8
        ? "#16a34a"
        : analise.score_oportunidade >= 6
          ? "#d97706"
          : "#dc2626";

    const linhasItens =
      analise.itens_principais.length > 0
        ? analise.itens_principais
            .map(
              (it, idx) => `
              <tr>
                <td><strong>#${idx + 1}</strong> ${this.escaparHtml(it.item)}</td>
                <td>${this.escaparHtml(String(it.quantidade))}</td>
                <td>${this.escaparHtml(it.valor_estimado ?? "Não detalhado")}</td>
                <td>${this.escaparHtml(it.especificacao)}</td>
              </tr>`,
            )
            .join("")
        : `<tr><td colspan="4">Nenhum item detalhado separadamente.</td></tr>`;

    const listaExigencias = analise.exigencias_tecnicas
      .map((ex) => `<li>${this.escaparHtml(ex)}</li>`)
      .join("");

    const listaRiscos = analise.riscos_identificados
      .map((ri) => `<li>${this.escaparHtml(ri)}</li>`)
      .join("");

    const listaEstrategia = (analise.pontos_estrategicos_proposta ?? [])
      .map((pt) => `<li>${this.escaparHtml(pt)}</li>`)
      .join("");

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>Dossiê Licitação ${item.anoCompra}/${item.sequencialCompra} - ${this.escaparHtml(item.unidadeOrgao?.municipioNome ?? "")}</title>
  <style>
    :root { --primary: #0f172a; --accent: #2563eb; --bg: #f8fafc; --card: #ffffff; --border: #e2e8f0; }
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: var(--bg); color: #1e293b; margin: 0; padding: 24px; line-height: 1.5; }
    .container { max-width: 1020px; margin: 0 auto; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 32px; box-shadow: 0 4px 16px rgba(0,0,0,0.05); }
    .top-bar { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid var(--border); padding-bottom: 20px; margin-bottom: 24px; gap: 16px; }
    .title h1 { margin: 0 0 6px 0; font-size: 22px; color: var(--primary); }
    .title p { margin: 0; font-size: 13px; color: #64748b; }
    .score-box { background: ${corScore}; color: #fff; padding: 12px 20px; border-radius: 10px; text-align: center; min-width: 150px; }
    .score-box .num { font-size: 28px; font-weight: 800; line-height: 1.1; }
    .score-box .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.95; }
    .recommendation { background: #eff6ff; border-left: 4px solid var(--accent); padding: 14px 18px; border-radius: 6px; margin-bottom: 24px; }
    .recommendation strong { color: #1d4ed8; display: block; margin-bottom: 4px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .kv { background: #f8fafc; border: 1px solid var(--border); padding: 10px 14px; border-radius: 8px; }
    .kv span { display: block; font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 600; }
    .kv strong { font-size: 14px; color: #0f172a; word-break: break-word; }
    h2 { font-size: 16px; color: var(--primary); border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-top: 28px; margin-bottom: 14px; text-transform: uppercase; letter-spacing: 0.4px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 13.5px; }
    th, td { border: 1px solid var(--border); padding: 10px 12px; text-align: left; vertical-align: top; }
    th { background: #f1f5f9; font-weight: 700; color: #334155; }
    ul { margin: 0 0 20px 0; padding-left: 20px; }
    li { margin-bottom: 8px; font-size: 14px; }
    .btn-print { background: var(--accent); color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; margin-bottom: 16px; }
    @media print { body { background: #fff; padding: 0; } .container { box-shadow: none; border: none; padding: 0; } .btn-print { display: none; } }
  </style>
</head>
<body>
  <div class="container">
    <button class="btn-print" onclick="window.print()">🖨️ Imprimir / Salvar como PDF</button>
    <div class="top-bar">
      <div class="title">
        <h1>Dossiê Executivo de Licitação — ${this.escaparHtml(item.unidadeOrgao?.municipioNome ?? "Município")} / ${this.escaparHtml(item.unidadeOrgao?.ufSigla ?? "UF")}</h1>
        <p><strong>Órgão:</strong> ${this.escaparHtml(orgaoNome)} (CNPJ: ${this.escaparHtml(item.orgaoEntidade.cnpj)}) | <strong>Categoria:</strong> ${this.escaparHtml(categoria.toUpperCase())}</p>
        <p><strong>Compra PNCP:</strong> ${item.anoCompra}/${item.sequencialCompra} | <strong>Gerado em:</strong> ${this.escaparHtml(dataGeracao)} | <strong>IA:</strong> ${this.escaparHtml(this.aiService.getModelName())}</p>
      </div>
      <div class="score-box">
        <div class="num">${analise.score_oportunidade}/10</div>
        <div class="lbl">${this.escaparHtml(classificacaoScore.split("(")[0]?.trim() ?? "SCORE")}</div>
      </div>
    </div>

    <div class="recommendation">
      <strong>Parecer Recomendado: ${this.escaparHtml(analise.recomendacao_participacao)}</strong>
      <div>${this.escaparHtml(analise.justificativa_score)}</div>
    </div>

    <h2>1. Ficha Técnica e Operacional</h2>
    <div class="grid">
      <div class="kv"><span>Modalidade</span><strong>${this.escaparHtml(item.modalidadeNome ?? "Pregão Eletrônico")}</strong></div>
      <div class="kv"><span>Valor Total Estimado</span><strong>${this.escaparHtml(valorFormatado)}</strong></div>
      <div class="kv"><span>Registro de Preços (SRP)</span><strong>${this.escaparHtml(analise.dados_operacionais.sistema_registro_precos)}</strong></div>
      <div class="kv"><span>Critério de Julgamento</span><strong>${this.escaparHtml(analise.dados_operacionais.criterio_julgamento)}</strong></div>
      <div class="kv"><span>Modo de Disputa</span><strong>${this.escaparHtml(analise.dados_operacionais.modo_disputa)}</strong></div>
      <div class="kv"><span>Exclusividade ME/EPP</span><strong>${this.escaparHtml(analise.dados_operacionais.exclusivo_me_epp)}</strong></div>
      <div class="kv"><span>Portal de Compras</span><strong>${this.escaparHtml(analise.dados_operacionais.portal_compras)}</strong></div>
      <div class="kv"><span>Garantia Exigida</span><strong>${this.escaparHtml(analise.dados_operacionais.garantia_exigida)}</strong></div>
    </div>

    <h2>2. Resumo Executivo e Objeto</h2>
    <p><strong>Síntese Executiva:</strong> ${this.escaparHtml(analise.resumo_executivo)}</p>
    <p><strong>Objeto Oficial (PNCP):</strong> ${this.escaparHtml(item.objetoCompra ?? "")}</p>
    ${urlEdital ? `<p><strong>Link Direto do Edital no PNCP:</strong> <a href="${this.escaparHtml(urlEdital)}" target="_blank">${this.escaparHtml(urlEdital)}</a></p>` : ""}

    <h2>3. Cronograma e Condições de Execução</h2>
    <div class="grid">
      <div class="kv"><span>Limite Envio Proposta</span><strong>${this.escaparHtml(analise.prazos_criticos.data_envio_proposta ?? "Não informado")}</strong></div>
      <div class="kv"><span>Sessão Pública</span><strong>${this.escaparHtml(analise.prazos_criticos.data_sessao_publica ?? "Não informado")}</strong></div>
      <div class="kv"><span>Prazo de Impugnação</span><strong>${this.escaparHtml(analise.prazos_criticos.prazo_impugnacao ?? "Não informado")}</strong></div>
      <div class="kv"><span>Prazo de Entrega</span><strong>${this.escaparHtml(analise.prazos_criticos.prazo_entrega ?? "Não informado")}</strong></div>
      <div class="kv"><span>Local de Entrega</span><strong>${this.escaparHtml(analise.prazos_criticos.local_entrega ?? "Não informado")}</strong></div>
      <div class="kv"><span>Prazo de Pagamento</span><strong>${this.escaparHtml(analise.prazos_criticos.prazo_pagamento ?? "Não informado")}</strong></div>
      <div class="kv"><span>Validade da Proposta</span><strong>${this.escaparHtml(analise.prazos_criticos.validade_proposta ?? "Não informado")}</strong></div>
      <div class="kv"><span>Vigência Contratual</span><strong>${this.escaparHtml(analise.prazos_criticos.vigencia_contrato ?? "Não informado")}</strong></div>
    </div>

    <h2>4. Itens Principais / Lotes Identificados</h2>
    <table>
      <thead>
        <tr>
          <th style="width: 26%">Item / Lote</th>
          <th style="width: 16%">Quantidade</th>
          <th style="width: 18%">Valor Estimado</th>
          <th style="width: 40%">Especificação Técnica</th>
        </tr>
      </thead>
      <tbody>
        ${linhasItens}
      </tbody>
    </table>

    <h2>5. Checklist de Habilitação e Exigências Regulatórias (ANVISA / AFE / Técnica)</h2>
    <ul>${listaExigencias || "<li>Nenhuma exigência específica detalhada.</li>"}</ul>

    <h2>6. Matriz de Riscos e Pontos de Atenção</h2>
    <ul>${listaRiscos || "<li>Nenhum risco crítico identificado.</li>"}</ul>

    <h2>7. Recomendações Estratégicas para a Proposta</h2>
    <ul>${listaEstrategia || "<li>Revisar integralmente o edital e anexos antes do envio da proposta.</li>"}</ul>
  </div>
</body>
</html>`;
  }

  /**
   * Processa individualmente uma licitação da saúde:
   * Filtro Município -> Filtro Saúde -> Deduplicação -> Extração PDF em RAM -> IA ->
   * Se Score >= mínimo: Cria pasta `Fortaleza - DD-MM-YYYY - <categoria> 01` e salva PDF + TXT + HTML.
   * Se Score < mínimo: Marca como DESCARTADA e grava na tabela `licitacoes_descartadas` com o motivo do descarte.
   */
  private async processarItem(
    item: PncpContratacaoItem,
    stats: EstatisticasExecucao,
  ): Promise<void> {
    const cnpj = item.orgaoEntidade?.cnpj;
    const ano = item.anoCompra;
    const sequencial = item.sequencialCompra;

    if (!cnpj || !ano || !sequencial) {
      return;
    }

    // 0. Filtro de Município (ex: "Fortaleza" ou "TODAS" configurado no .env)
    if (!this.pncpService.ehMunicipioPermitido(item.unidadeOrgao?.municipioNome)) {
      return;
    }

    // 1. Filtro Primário (Regex Saúde) - se não passar, ignora sem chamar IA nem gravar
    if (!this.pncpService.ehLicitacaoSaude(item.objetoCompra)) {
      return;
    }
    stats.filtradasSaude++;

    // 2. Deduplicação no Banco de Dados
    const jaExiste = await this.licitacaoJaProcessada(cnpj, ano, sequencial);
    if (jaExiste) {
      stats.jaExistentes++;
      console.log(
        `[LicitacaoService] Ignorando licitação já processada: ${cnpj}/${ano}/${sequencial}`,
      );
      return;
    }

    const municipio = item.unidadeOrgao?.municipioNome ?? "Município N/I";
    const uf = item.unidadeOrgao?.ufSigla ?? "UF";
    console.log(
      `\n[LicitacaoService] Nova licitação de saúde detectada: [${municipio}/${uf}] (${cnpj}/${ano}/${sequencial})`,
    );
    console.log(`  Objeto: ${item.objetoCompra}`);

    // 3. Consulta de Anexos no PNCP
    const urlEdital = await this.pncpService.buscarUrlEditalOuTr(cnpj, ano, sequencial);

    // 4. Download em memória e extração cirúrgica com pdf-parse
    let textoEdital: string | null = null;
    let bufferPdf: Buffer | null = null;
    if (urlEdital) {
      console.log(`  Baixando e extraindo PDF em memória: ${urlEdital}`);
      const pdfExtraido = await this.pdfService.baixarEExtrairPdf(urlEdital);
      textoEdital = pdfExtraido.texto;
      bufferPdf = pdfExtraido.buffer;
    } else {
      console.log("  Nenhum anexo de Edital/TR encontrado. Utilizando fallback do objeto.");
    }

    const fonteAnalise: "PDF" | "OBJETO_FALLBACK" = textoEdital ? "PDF" : "OBJETO_FALLBACK";

    // 5. Análise estruturada com IA (Provedor configurável via .env)
    console.log(
      `  Executando análise via IA [${this.aiService.getModelName()}] (fonte: ${fonteAnalise})...`,
    );
    const analise = await this.aiService.analisarLicitacao({
      orgaoNome: item.orgaoEntidade.razaoSocial ?? item.unidadeOrgao?.nomeUnidade ?? "Órgão Público",
      municipio,
      uf,
      modalidade: item.modalidadeNome ?? "Pregão Eletrônico",
      objetoCompra: item.objetoCompra ?? "",
      valorTotalEstimado: item.valorTotalEstimado ?? null,
      dataAberturaProposta: item.dataAberturaProposta ?? null,
      dataEncerramentoProposta: item.dataEncerramentoProposta ?? null,
      textoEdital,
    });

    const categoria =
      this.pncpService.identificarCategoria(item.objetoCompra) !== "saude"
        ? this.pncpService.identificarCategoria(item.objetoCompra)
        : analise.categoria_principal || "saude";

    const aprovada = analise.score_oportunidade >= this.scoreMinimoDownload;
    const statusProspeccao: "APROVADA" | "DESCARTADA" = aprovada ? "APROVADA" : "DESCARTADA";

    // 6. Se APROVADA (Score >= mínimo), cria a pasta `Fortaleza - DD-MM-YYYY - <categoria> 01` e salva arquivos
    let pastaSalva: string | null = null;
    if (aprovada) {
      pastaSalva = this.salvarArquivosLocais(
        item,
        urlEdital,
        bufferPdf,
        analise,
        categoria,
      );
      stats.aprovadas++;
      stats.arquivosSalvosDisco++;
    } else {
      stats.descartadasPelaIa++;
    }

    // 7. Persistência no PostgreSQL (`licitacoes`, `licitacao_analises` e `licitacoes_descartadas`)
    const licitacaoId = await this.salvarLicitacaoEAnalise(
      item,
      urlEdital,
      fonteAnalise,
      analise,
      categoria,
      statusProspeccao,
      pastaSalva,
    );

    stats.analisadasComSucesso++;

    if (aprovada && pastaSalva) {
      console.log(
        `  ✅ [APROVADA | Score: ${analise.score_oportunidade}/10 | ID: ${licitacaoId}] ${analise.recomendacao_participacao}`,
      );
      console.log(`  📂 Pasta criada: ${pastaSalva}`);
    } else {
      console.log(
        `  ❌ [DESCARTADA PELA IA | Score: ${analise.score_oportunidade}/10 | ID: ${licitacaoId}]`,
      );
      console.log(`  🛑 Motivo do Descarte: ${analise.motivo_descarte}`);
    }
  }

  /**
   * Gera ao final de cada ciclo/dia o Relatório Consolidado de Prospecção do Dia
   * (`Relatorio_Final_Dia_DD-MM-YYYY.txt` e `.html`) dentro de `src/editais/Prospecção DD-MM-YYYY/`,
   * com os totais analisados pela IA, os aprovados e a tabela completa dos descartados com o motivo.
   */
  public async gerarRelatorioDiarioProspeccao(): Promise<{
    caminhoTxt: string;
    caminhoHtml: string;
    totalAnalisadosDia: number;
    totalAprovadosDia: number;
    totalDescartadosDia: number;
  }> {
    let client: PoolClient | null = null;
    try {
      client = await getDbClient();

      const resAprovadas = await client.query<RegistroAprovadoDia>(`
        SELECT
          l.id,
          l.municipio,
          l.uf,
          l.orgao_nome,
          l.ano,
          l.sequencial,
          a.categoria,
          l.valor_total_estimado,
          a.score_oportunidade,
          a.prazos_criticos->>'recomendacao_participacao' AS recomendacao_participacao,
          a.pasta_local,
          l.objeto_compra
        FROM licitacao_analises a
        JOIN licitacoes l ON l.id = a.licitacao_id
        WHERE a.data_prospeccao = CURRENT_DATE
          AND a.status_prospeccao = 'APROVADA'
        ORDER BY a.score_oportunidade DESC, l.id ASC
      `);

      const resDescartadas = await client.query<RegistroDescartadoDia>(`
        SELECT
          d.id,
          d.licitacao_id,
          d.municipio,
          d.uf,
          d.orgao_nome,
          d.cnpj_orgao,
          d.ano,
          d.sequencial,
          d.categoria,
          d.valor_total_estimado,
          d.score_oportunidade,
          d.motivo_descarte,
          d.objeto_compra
        FROM licitacoes_descartadas d
        WHERE d.data_prospeccao = CURRENT_DATE
        ORDER BY d.score_oportunidade DESC, d.id ASC
      `);

      const aprovadas = resAprovadas.rows;
      const descartadas = resDescartadas.rows;
      const totalAprovadosDia = aprovadas.length;
      const totalDescartadosDia = descartadas.length;
      const totalAnalisadosDia = totalAprovadosDia + totalDescartadosDia;

      const pastaDia = this.obterPastaDiaProspeccao();
      const dataHojeBr = LicitacaoService.formatarDataBr(new Date());
      const dataHoraGeracao = new Date().toLocaleString("pt-BR", {
        timeZone: "America/Fortaleza",
      });

      const secaoAprovadasTxt =
        aprovadas.length > 0
          ? aprovadas
              .map((ap, idx) => {
                const pastaNome = ap.pasta_local ? path.basename(ap.pasta_local) : "Sem pasta";
                const valor = ap.valor_total_estimado
                  ? `R$ ${Number(ap.valor_total_estimado).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
                  : "Sigiloso/N.I.";
                return (
                  `  ${String(idx + 1).padStart(2, "0")}. [SCORE ${ap.score_oportunidade}/10] ${ap.municipio ?? "N/I"}/${ap.uf ?? "UF"} | Compra: ${ap.ano}/${ap.sequencial} | Categoria: ${ap.categoria}\n` +
                  `      Órgão  : ${ap.orgao_nome ?? "N/I"} | Valor: ${valor}\n` +
                  `      Pasta  : ${pastaNome}\n` +
                  `      Objeto : ${ap.objeto_compra.replace(/\s+/g, " ").substring(0, 180)}...`
                );
              })
              .join("\n  ------------------------------------------------------------------------------\n")
          : "  Nenhum edital aprovado na data de hoje.";

      const secaoDescartadasTxt =
        descartadas.length > 0
          ? descartadas
              .map((dc, idx) => {
                const valor = dc.valor_total_estimado
                  ? `R$ ${Number(dc.valor_total_estimado).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
                  : "Sigiloso/N.I.";
                return (
                  `  ${String(idx + 1).padStart(2, "0")}. [SCORE ${dc.score_oportunidade}/10] ${dc.municipio ?? "N/I"}/${dc.uf ?? "UF"} | Compra: ${dc.ano}/${dc.sequencial} | Categoria: ${dc.categoria}\n` +
                  `      Órgão              : ${dc.orgao_nome ?? "N/I"} (CNPJ: ${dc.cnpj_orgao}) | Valor: ${valor}\n` +
                  `      Objeto             : ${dc.objeto_compra.replace(/\s+/g, " ").substring(0, 160)}...\n` +
                  `      MOTIVO DO DESCARTE : ${dc.motivo_descarte}`
                );
              })
              .join("\n  ------------------------------------------------------------------------------\n")
          : "  Nenhum edital descartado pela IA na data de hoje.";

      const conteudoTxt = [
        "================================================================================",
        `            RELATÓRIO DIÁRIO DE PROSPECÇÃO DE LICITAÇÕES (${dataHojeBr})        `,
        "================================================================================",
        `ATUALIZADO EM                     : ${dataHoraGeracao}`,
        `PASTA DE PROSPECÇÃO DO DIA        : ${pastaDia}`,
        `SCORE MÍNIMO DE APROVAÇÃO         : ${this.scoreMinimoDownload} / 10`,
        "--------------------------------------------------------------------------------",
        "RESUMO QUANTITATIVO DO DIA (ANALISADOS PELA IA):",
        `  - TOTAL DE PROCESSOS ANALISADOS PELA IA : ${totalAnalisadosDia}`,
        `  - TOTAL APROVADOS (COM PASTA E EDITAL)  : ${totalAprovadosDia}`,
        `  - TOTAL DESCARTADOS PELA IA             : ${totalDescartadosDia}`,
        "================================================================================",
        `1. RELAÇÃO DE PROCESSOS APROVADOS NO DIA (${totalAprovadosDia})`,
        "================================================================================",
        secaoAprovadasTxt,
        "",
        "================================================================================",
        `2. TABELA DE PROCESSOS DESCARTADOS PELA IA E MOTIVOS (${totalDescartadosDia})`,
        "================================================================================",
        secaoDescartadasTxt,
        "================================================================================",
      ].join("\n");

      const caminhoTxt = path.join(
        pastaDia,
        `Relatorio_Final_Dia_${dataHojeBr}.txt`,
      );
      fs.writeFileSync(caminhoTxt, conteudoTxt, "utf-8");

      const linhasAprovadasHtml =
        aprovadas.length > 0
          ? aprovadas
              .map((ap, idx) => {
                const pastaNome = ap.pasta_local ? path.basename(ap.pasta_local) : "-";
                const valor = ap.valor_total_estimado
                  ? `R$ ${Number(ap.valor_total_estimado).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
                  : "Sigiloso";
                return `
                <tr>
                  <td>${idx + 1}</td>
                  <td><span class="badge badge-ok">${ap.score_oportunidade}/10</span></td>
                  <td><strong>${this.escaparHtml(ap.municipio ?? "")}/${this.escaparHtml(ap.uf ?? "")}</strong><br/><small>${this.escaparHtml(ap.orgao_nome ?? "")}</small></td>
                  <td>${ap.ano}/${ap.sequencial}</td>
                  <td>${this.escaparHtml(ap.categoria)}</td>
                  <td>${this.escaparHtml(valor)}</td>
                  <td><code>${this.escaparHtml(pastaNome)}</code></td>
                  <td>${this.escaparHtml(ap.objeto_compra)}</td>
                </tr>`;
              })
              .join("")
          : `<tr><td colspan="8">Nenhum processo aprovado hoje.</td></tr>`;

      const linhasDescartadasHtml =
        descartadas.length > 0
          ? descartadas
              .map((dc, idx) => {
                const valor = dc.valor_total_estimado
                  ? `R$ ${Number(dc.valor_total_estimado).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
                  : "Sigiloso";
                return `
                <tr>
                  <td>${idx + 1}</td>
                  <td><span class="badge badge-no">${dc.score_oportunidade}/10</span></td>
                  <td><strong>${this.escaparHtml(dc.municipio ?? "")}/${this.escaparHtml(dc.uf ?? "")}</strong><br/><small>${this.escaparHtml(dc.orgao_nome ?? "")}</small></td>
                  <td>${dc.ano}/${dc.sequencial}</td>
                  <td>${this.escaparHtml(dc.categoria)}</td>
                  <td>${this.escaparHtml(valor)}</td>
                  <td><strong>${this.escaparHtml(dc.motivo_descarte)}</strong></td>
                  <td>${this.escaparHtml(dc.objeto_compra)}</td>
                </tr>`;
              })
              .join("")
          : `<tr><td colspan="8">Nenhum processo descartado pela IA hoje.</td></tr>`;

      const conteudoHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>Relatório Diário de Prospecção - ${dataHojeBr}</title>
  <style>
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #f8fafc; color: #1e293b; margin: 0; padding: 24px; }
    .container { max-width: 1200px; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 32px; box-shadow: 0 4px 16px rgba(0,0,0,0.05); }
    h1 { margin: 0 0 6px 0; color: #0f172a; font-size: 24px; }
    .sub { color: #64748b; font-size: 13px; margin-bottom: 24px; }
    .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 28px; }
    .card { padding: 18px 20px; border-radius: 10px; border: 1px solid #e2e8f0; background: #f8fafc; }
    .card .num { font-size: 32px; font-weight: 800; }
    .card .lbl { font-size: 12px; text-transform: uppercase; color: #475569; font-weight: 700; }
    .card.total .num { color: #2563eb; }
    .card.ok { background: #f0fdf4; border-color: #bbf7d0; }
    .card.ok .num { color: #16a34a; }
    .card.no { background: #fef2f2; border-color: #fecaca; }
    .card.no .num { color: #dc2626; }
    h2 { font-size: 17px; color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; margin-top: 32px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
    th, td { border: 1px solid #e2e8f0; padding: 10px 12px; text-align: left; vertical-align: top; }
    th { background: #f1f5f9; font-weight: 700; }
    .badge { display: inline-block; padding: 4px 8px; border-radius: 6px; font-weight: 700; color: #fff; font-size: 12px; }
    .badge-ok { background: #16a34a; }
    .badge-no { background: #dc2626; }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    .btn-print { background: #2563eb; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 600; float: right; }
    @media print { .btn-print { display: none; } body { background: #fff; padding: 0; } .container { border: none; box-shadow: none; padding: 0; } }
  </style>
</head>
<body>
  <div class="container">
    <button class="btn-print" onclick="window.print()">🖨️ Imprimir / Salvar em PDF</button>
    <h1>Relatório Consolidado — Prospecção ${dataHojeBr}</h1>
    <div class="sub">Atualizado em: ${this.escaparHtml(dataHoraGeracao)} | Score mínimo de aprovação: ${this.scoreMinimoDownload}/10</div>

    <div class="cards">
      <div class="card total">
        <div class="num">${totalAnalisadosDia}</div>
        <div class="lbl">Processos Analisados pela IA</div>
      </div>
      <div class="card ok">
        <div class="num">${totalAprovadosDia}</div>
        <div class="lbl">Aprovados (Com Pasta e Edital)</div>
      </div>
      <div class="card no">
        <div class="num">${totalDescartadosDia}</div>
        <div class="lbl">Descartados pela IA (Score &lt; ${this.scoreMinimoDownload})</div>
      </div>
    </div>

    <h2>1. Processos Aprovados (${totalAprovadosDia})</h2>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Score</th>
          <th>Município / Órgão</th>
          <th>Compra</th>
          <th>Categoria</th>
          <th>Valor Estimado</th>
          <th>Pasta Criada</th>
          <th>Objeto</th>
        </tr>
      </thead>
      <tbody>${linhasAprovadasHtml}</tbody>
    </table>

    <h2>2. Tabela de Processos Descartados pela IA e Motivo do Descarte (${totalDescartadosDia})</h2>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Score</th>
          <th>Município / Órgão</th>
          <th>Compra</th>
          <th>Categoria</th>
          <th>Valor Estimado</th>
          <th style="width: 30%">Motivo Claro do Descarte (IA)</th>
          <th>Objeto</th>
        </tr>
      </thead>
      <tbody>${linhasDescartadasHtml}</tbody>
    </table>
  </div>
</body>
</html>`;

      const caminhoHtml = path.join(
        pastaDia,
        `Relatorio_Final_Dia_${dataHojeBr}.html`,
      );
      fs.writeFileSync(caminhoHtml, conteudoHtml, "utf-8");

      return {
        caminhoTxt,
        caminhoHtml,
        totalAnalisadosDia,
        totalAprovadosDia,
        totalDescartadosDia,
      };
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  /**
   * Executa o pipeline completo para o intervalo de datas recente (D-1 até D)
   * e gera o Relatório Consolidado do Dia ao finalizar.
   */
  public async executarPipeline(): Promise<EstatisticasExecucao> {
    const stats: EstatisticasExecucao = {
      paginasConsultadas: 0,
      licitacoesInspecionadas: 0,
      filtradasSaude: 0,
      jaExistentes: 0,
      analisadasComSucesso: 0,
      aprovadas: 0,
      descartadasPelaIa: 0,
      arquivosSalvosDisco: 0,
      errosProcessamento: 0,
    };

    const { dataInicial, dataFinal } = this.pncpService.obterIntervaloRecente();
    const { uf, municipio } = this.pncpService.obterFiltroLocalidade();
    console.log(
      `[LicitacaoService] Iniciando varredura no PNCP (Período: ${dataInicial} a ${dataFinal} | UF: ${uf} | Município: ${municipio} | Score mín. aprovação: ${this.scoreMinimoDownload})...`,
    );

    try {
      const primeiraPagina = await this.pncpService.buscarPaginaPublicacoes(
        1,
        dataInicial,
        dataFinal,
      );

      const totalPaginas = primeiraPagina.totalPaginas ?? 0;
      if (totalPaginas === 0 || primeiraPagina.empty) {
        console.log("[LicitacaoService] Nenhuma publicação encontrada para o período.");
        return stats;
      }

      console.log(`[LicitacaoService] Total de páginas a processar: ${totalPaginas}`);

      for (let pagina = 1; pagina <= totalPaginas; pagina++) {
        console.log(`\n[LicitacaoService] Processando página ${pagina}/${totalPaginas}...`);

        let respostaPagina = primeiraPagina;
        if (pagina > 1) {
          try {
            respostaPagina = await this.pncpService.buscarPaginaPublicacoes(
              pagina,
              dataInicial,
              dataFinal,
            );
          } catch (erroPagina) {
            const msg = erroPagina instanceof Error ? erroPagina.message : String(erroPagina);
            console.error(`[LicitacaoService] Falha ao obter página ${pagina}: ${msg}`);
            stats.errosProcessamento++;
            continue;
          }
        }

        stats.paginasConsultadas++;
        const itens = Array.isArray(respostaPagina.data) ? respostaPagina.data : [];

        for (const item of itens) {
          stats.licitacoesInspecionadas++;
          try {
            await this.processarItem(item, stats);
          } catch (erroItem) {
            stats.errosProcessamento++;
            const msg = erroItem instanceof Error ? erroItem.message : String(erroItem);
            console.error(
              `[LicitacaoService] Erro ao processar licitação ${item.orgaoEntidade?.cnpj}/${item.anoCompra}/${item.sequencialCompra}: ${msg}`,
            );
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[LicitacaoService] Erro crítico durante execução do pipeline: ${message}`);
    }

    try {
      const relatorioDia = await this.gerarRelatorioDiarioProspeccao();
      console.log("\n================================================================================");
      console.log("📊 RELATÓRIO FINAL DE PROSPECÇÃO DO DIA GERADO COM SUCESSO:");
      console.log(`  - Total Analisados pela IA hoje : ${relatorioDia.totalAnalisadosDia}`);
      console.log(`  - Total Aprovados (Score >= ${this.scoreMinimoDownload})  : ${relatorioDia.totalAprovadosDia}`);
      console.log(`  - Total Descartados pela IA     : ${relatorioDia.totalDescartadosDia}`);
      console.log(`  - Relatório TXT                 : ${relatorioDia.caminhoTxt}`);
      console.log(`  - Relatório HTML (Visual/PDF)   : ${relatorioDia.caminhoHtml}`);
      console.log("================================================================================");
    } catch (erroRelatorio) {
      const msg = erroRelatorio instanceof Error ? erroRelatorio.message : String(erroRelatorio);
      console.error(`[LicitacaoService] Erro ao gerar relatório consolidado do dia: ${msg}`);
    }

    console.log("\n[LicitacaoService] Resumo da execução:", stats);
    return stats;
  }
}
