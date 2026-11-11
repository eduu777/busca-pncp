import axios from "axios";
import pdfParse from "pdf-parse";

const LIMITE_PADRAO_CARACTERES = 14_000;

interface SecaoAlvo {
  nome: string;
  regexInicio: RegExp;
  quotaCaracteres: number;
}

const SECOES_PRIORITARIAS: ReadonlyArray<SecaoAlvo> = [
  {
    nome: "OBJETO E DATAS PRELIMINARES",
    regexInicio: /\b(?:DO\s+OBJETO|1\.?\s*-?\s*DO\s+OBJETO|OBJETO\s+DA\s+LICITA[CÇ][AÃ]O)\b/i,
    quotaCaracteres: 2_800,
  },
  {
    nome: "HABILITAÇÃO E QUALIFICAÇÃO TÉCNICA",
    regexInicio:
      /\b(?:QUALIFICA[CÇ][AÃ]O\s+T[EÉ]CNICA|DA\s+HABILITA[CÇ][AÃ]O|EXIG[EÊ]NCIAS\s+T[EÉ]CNICAS|ANVISA|AUTORIZA[CÇ][AÃ]O\s+DE\s+FUNCIONAMENTO)\b/i,
    quotaCaracteres: 3_500,
  },
  {
    nome: "TERMO DE REFERÊNCIA / ESPECIFICAÇÕES E ITENS",
    regexInicio:
      /\b(?:TERMO\s+DE\s+REFER[EÊ]NCIA|ESPECIFICA[CÇ][OÕ]ES\s+T[EÉ]CNICAS|RELA[CÇ][AÃ]O\s+DE\s+ITENS|PLANILHA\s+OR[CÇ]AMENT[AÁ]RIA)\b/i,
    quotaCaracteres: 5_000,
  },
  {
    nome: "SANÇÕES E PENALIDADES",
    regexInicio:
      /\b(?:DAS\s+SAN[CÇ][OÕ]ES|SAN[CÇ][OÕ]ES\s+ADMINISTRATIVAS|DAS\s+PENALIDADES|INFRA[CÇ][OÕ]ES\s+ADMINISTRATIVAS)\b/i,
    quotaCaracteres: 1_800,
  },
];

export interface PdfExtraido {
  texto: string | null;
  buffer: Buffer | null;
}

export class PdfService {
  private readonly maxCaracteres: number;

  constructor(maxCaracteres: number = LIMITE_PADRAO_CARACTERES) {
    this.maxCaracteres = maxCaracteres;
  }

  /**
   * Faz o download do arquivo em memória (`responseType: 'arraybuffer'`),
   * valida se é um PDF válido, extrai o texto via `pdf-parse` e aplica poda cirúrgica.
   * Retorna tanto o texto podado quanto o Buffer em memória (para gravação condicional se o score for alto).
   */
  public async baixarEExtrairPdf(url: string): Promise<PdfExtraido> {
    try {
      const response = await axios.get<ArrayBuffer>(url, {
        responseType: "arraybuffer",
        timeout: 45_000,
        maxContentLength: 50 * 1024 * 1024, // Limite de segurança em RAM: 50 MB
        headers: {
          "User-Agent": "MonitorLicitacoesSaude/2.0 (Node.js; TypeScript)",
        },
      });

      const buffer = Buffer.from(response.data);

      // Verifica a assinatura mágica "%PDF-" nos primeiros bytes para evitar parsear ZIP/HTML
      const assinatura = buffer.subarray(0, 5).toString("ascii");
      if (!assinatura.startsWith("%PDF-")) {
        console.warn(
          `[PdfService] Arquivo baixado de ${url} não possui assinatura PDF válida (cabeçalho: "${assinatura}").`,
        );
        return { texto: null, buffer: null };
      }

      const resultado = await pdfParse(buffer);
      const textoBruto = resultado.text ?? "";

      const textoNormalizado = this.higienizarTexto(textoBruto);
      if (textoNormalizado.length < 50) {
        console.warn(
          `[PdfService] PDF extraído possui texto insuficiente (${textoNormalizado.length} chars).`,
        );
        return { texto: null, buffer };
      }

      return {
        texto: this.podarSecoesEssenciais(textoNormalizado),
        buffer,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[PdfService] Falha ao baixar ou extrair PDF em memória (${url}): ${message}`);
      return { texto: null, buffer: null };
    }
  }

  public async baixarEExtrairTexto(url: string): Promise<string | null> {
    const res = await this.baixarEExtrairPdf(url);
    return res.texto;
  }

  /**
   * Remove ruídos de formatação, múltiplos espaços em branco, linhas vazias repetidas
   * e caracteres de controle irrelevantes.
   */
  private higienizarTexto(texto: string): string {
    return texto
      .replace(/\r\n/g, "\n")
      .replace(/[^\S\n]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Aplica poda cirúrgica priorizando as seções críticas do edital (Preâmbulo/Datas,
   * Objeto, Habilitação/Qualificação Técnica, Termo de Referência e Sanções)
   * garantindo limite estrito entre ~15.000 e 20.000 caracteres.
   */
  public podarSecoesEssenciais(texto: string): string {
    if (texto.length <= this.maxCaracteres) {
      return texto;
    }

    const blocosExtraidos: string[] = [];

    // 1. Sempre preserva o preâmbulo do Edital (primeiros 2.000 caracteres costumam conter datas da sessão, portal e órgão)
    const preambulo = texto.slice(0, 2_000);
    blocosExtraidos.push(`=== [PREÂMBULO E DADOS INICIAIS] ===\n${preambulo}`);

    // 2. Busca cada seção prioritária via Regex e extrai sua janela de texto
    for (const secao of SECOES_PRIORITARIAS) {
      const match = secao.regexInicio.exec(texto);
      if (match && typeof match.index === "number") {
        const inicio = match.index;
        const trecho = texto.slice(inicio, inicio + secao.quotaCaracteres).trim();
        if (trecho.length > 0) {
          blocosExtraidos.push(`=== [${secao.nome}] ===\n${trecho}`);
        }
      }
    }

    let resultadoCombinado = blocosExtraidos.join("\n\n");

    // Se nenhuma seção específica além do preâmbulo foi casada, preenche com início + meio/fim do documento
    if (blocosExtraidos.length === 1) {
      const metadeQuota = Math.floor(this.maxCaracteres / 2);
      const parteInicial = texto.slice(0, metadeQuota);
      const parteFinal = texto.slice(texto.length - metadeQuota);
      resultadoCombinado = `${parteInicial}\n\n=== [TRECHO FINAL / ANEXOS] ===\n${parteFinal}`;
    }

    // Garante corte estrito no limite máximo configurado (~18.000 caracteres)
    if (resultadoCombinado.length > this.maxCaracteres) {
      return resultadoCombinado.slice(0, this.maxCaracteres);
    }

    return resultadoCombinado;
  }
}

