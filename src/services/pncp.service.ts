import axios, { AxiosInstance } from "axios";

export interface PncpOrgaoEntidade {
  cnpj: string;
  razaoSocial?: string;
}

export interface PncpUnidadeOrgao {
  ufSigla?: string;
  municipioNome?: string;
  nomeUnidade?: string;
}

export interface PncpContratacaoItem {
  numeroControlePNCP?: string;
  anoCompra: number;
  sequencialCompra: number;
  objetoCompra?: string;
  modalidadeNome?: string;
  valorTotalEstimado?: number | null;
  dataPublicacaoPncp?: string | null;
  dataAberturaProposta?: string | null;
  dataEncerramentoProposta?: string | null;
  linkSistemaOrigem?: string | null;
  orgaoEntidade: PncpOrgaoEntidade;
  unidadeOrgao?: PncpUnidadeOrgao;
}

export interface PncpPublicacaoResponse {
  data: PncpContratacaoItem[];
  totalRegistros: number;
  totalPaginas: number;
  numeroPagina: number;
  paginasRestantes: number;
  empty: boolean;
}

export interface PncpArquivoItem {
  sequencialDocumento?: number;
  titulo?: string;
  tituloArquivo?: string;
  nomeArquivo?: string;
  tipoDocumentoId?: number;
  tipoDocumentoNome?: string;
  tipoDocumentoDescricao?: string;
  url: string;
  statusAtivo?: boolean;
}

/**
 * Termos da área da saúde (com suporte a acentuação opcional e plurais).
 * Inclui exatamente os termos exigidos: medicamento, hospital, saúde, farmácia,
 * material médico, equipamento médico, odontológico, enfermagem, laboratório,
 * ambulância, ubs, vacina, oxigênio (e variações diretas).
 */
const TERMOS_SAUDE: ReadonlyArray<string> = [
  "medicamentos?",
  "hospital(?:ar(?:es)?)?",
  "sa[uú]de",
  "farm[aá]cias?",
  "materiais?\\s+m[eé]dicos?",
  "materiais?\\s+hospitalar(?:es)?",
  "equipamentos?\\s+m[eé]dicos?",
  "equipamentos?\\s+hospitalar(?:es)?",
  "odontol[oó]gicos?",
  "enfermagem",
  "laborat[oó]rios?",
  "ambul[aâ]ncias?",
  "ubs",
  "vacinas?",
  "oxig[eê]nio",
];

const REGEX_SAUDE = new RegExp(`\\b(?:${TERMOS_SAUDE.join("|")})\\b`, "i");

export class PncpService {
  private readonly httpClient: AxiosInstance;
  private readonly uf: string;
  private readonly municipioFiltro: string;
  private readonly codigoModalidade: number;

  constructor() {
    this.httpClient = axios.create({
      baseURL: "https://pncp.gov.br/api",
      timeout: 30_000,
      headers: {
        Accept: "application/json",
        "User-Agent": "MonitorLicitacoesSaude/2.0 (Node.js; TypeScript)",
      },
    });

    this.uf = (process.env.PNCP_UF ?? "CE").trim().toUpperCase();
    this.municipioFiltro = (process.env.PNCP_MUNICIPIO ?? "TODAS").trim();
    this.codigoModalidade = Number(process.env.PNCP_MODALIDADE ?? 6);
  }

  public obterFiltroLocalidade(): { uf: string; municipio: string } {
    return {
      uf: this.uf,
      municipio: this.municipioFiltro || "TODAS",
    };
  }

  /**
   * Verifica se o município da licitação corresponde ao filtro configurado em `PNCP_MUNICIPIO`.
   * Se `PNCP_MUNICIPIO` for vazio, "TODAS" ou "TODOS", aceita qualquer cidade do estado.
   */
  public ehMunicipioPermitido(municipioNome?: string | null): boolean {
    const filtroNormalizado = PncpService.normalizarTexto(this.municipioFiltro);
    if (
      !filtroNormalizado ||
      filtroNormalizado === "todas" ||
      filtroNormalizado === "todos" ||
      filtroNormalizado === "*"
    ) {
      return true;
    }

    if (!municipioNome) {
      return false;
    }

    const municipioItemNormalizado = PncpService.normalizarTexto(municipioNome);
    return municipioItemNormalizado === filtroNormalizado;
  }

  private static normalizarTexto(valor: string): string {
    return valor
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  }

  /**
   * Formata um objeto Date para o padrão `YYYYMMDD` exigido pela API de consulta do PNCP.
   */
  public static formatarDataPncp(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}${month}${day}`;
  }

  /**
   * Retorna o intervalo recente [D-1, D] no formato `YYYYMMDD` (ou usa variáveis de ambiente caso definidas).
   */
  public obterIntervaloRecente(): { dataInicial: string; dataFinal: string } {
    if (process.env.PNCP_DATA_INICIAL && process.env.PNCP_DATA_FINAL) {
      return {
        dataInicial: process.env.PNCP_DATA_INICIAL,
        dataFinal: process.env.PNCP_DATA_FINAL,
      };
    }

    const hoje = new Date();
    const ontem = new Date(hoje);
    ontem.setDate(hoje.getDate() - 1);

    return {
      dataInicial: PncpService.formatarDataPncp(ontem),
      dataFinal: PncpService.formatarDataPncp(hoje),
    };
  }

  /**
   * Verifica se o objeto da contratação pertence ao escopo da área da saúde.
   */
  public ehLicitacaoSaude(objetoCompra?: string | null): boolean {
    if (!objetoCompra) {
      return false;
    }
    return REGEX_SAUDE.test(objetoCompra);
  }

  /**
   * Identifica a categoria principal da licitação da saúde para organização de pastas e banco
   * (ex: "medicamentos", "material hospitalar", "equipamentos hospitalares", "laboratorio", etc.).
   */
  public identificarCategoria(objetoCompra?: string | null): string {
    if (!objetoCompra) {
      return "saude";
    }

    const texto = PncpService.normalizarTexto(objetoCompra);

    if (/\b(medicamentos?|farmacias?|farmacos?)\b/.test(texto)) {
      return "medicamentos";
    }
    if (/\b(vacinas?|imunobiologicos?)\b/.test(texto)) {
      return "vacinas";
    }
    if (/\b(oxigenio|gases\s+medicinais)\b/.test(texto)) {
      return "oxigenio";
    }
    if (/\b(odontologicos?|odonto)\b/.test(texto)) {
      return "odontologico";
    }
    if (/\b(laboratorios?|laboratoriais|exames|reagentes)\b/.test(texto)) {
      return "laboratorio";
    }
    if (/\b(ambulancias?|uti\s+movel)\b/.test(texto)) {
      return "ambulancia";
    }
    if (/\b(equipamentos?\s+(?:medicos?|hospitalar(?:es)?)|videolaparoscopia|tomografo|raio-?x|ultrassom)\b/.test(texto)) {
      return "equipamentos medicos";
    }
    if (/\b(materiais?\s+(?:medicos?|hospitalar(?:es)?)|enfermagem|insumos\s+cirurgicos|correlatos)\b/.test(texto)) {
      return "material hospitalar";
    }
    if (/\b(ubs)\b/.test(texto)) {
      return "ubs";
    }
    if (/\b(hospital|hospitalar(?:es)?)\b/.test(texto)) {
      return "hospitalar";
    }

    return "saude";
  }

  /**
   * Consulta uma página de publicações no PNCP (`/consulta/v1/contratacoes/publicacao`).
   */
  public async buscarPaginaPublicacoes(
    pagina: number,
    dataInicial: string,
    dataFinal: string,
  ): Promise<PncpPublicacaoResponse> {
    try {
      const response = await this.httpClient.get<PncpPublicacaoResponse>(
        "/consulta/v1/contratacoes/publicacao",
        {
          params: {
            dataInicial,
            dataFinal,
            codigoModalidadeContratacao: this.codigoModalidade,
            uf: this.uf,
            pagina,
          },
        },
      );

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 204) {
        return {
          data: [],
          totalRegistros: 0,
          totalPaginas: 0,
          numeroPagina: pagina,
          paginasRestantes: 0,
          empty: true,
        };
      }

      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[PncpService] Erro ao buscar página ${pagina} (${dataInicial} a ${dataFinal}): ${message}`,
      );
      throw error;
    }
  }

  /**
   * Busca os arquivos anexos da licitação (`/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/arquivos`)
   * e seleciona a URL prioritária referente ao Edital ou Termo de Referência (TR).
   */
  public async buscarUrlEditalOuTr(
    cnpj: string,
    ano: number,
    sequencial: number,
  ): Promise<string | null> {
    try {
      const url = `/pncp/v1/orgaos/${encodeURIComponent(cnpj)}/compras/${ano}/${sequencial}/arquivos`;
      const response = await this.httpClient.get<PncpArquivoItem[]>(url);
      const arquivos = Array.isArray(response.data) ? response.data : [];

      if (arquivos.length === 0) {
        return null;
      }

      const arquivosAtivos = arquivos.filter((arq) => arq.statusAtivo !== false && Boolean(arq.url));
      if (arquivosAtivos.length === 0) {
        return null;
      }

      // Prioridade 1: Documento explicitamente identificado como Edital ou Termo de Referência
      const regexEditalOuTr = /\b(edital|termo\s+de\s+refer[eê]ncia|tr|aviso\s+de\s+contrata[cç][aã]o)\b/i;

      const candidatoPrioritario = arquivosAtivos.find((arq) => {
        const metadados = [
          arq.titulo,
          arq.tituloArquivo,
          arq.nomeArquivo,
          arq.tipoDocumentoNome,
          arq.tipoDocumentoDescricao,
        ]
          .filter(Boolean)
          .join(" ");
        return regexEditalOuTr.test(metadados);
      });

      if (candidatoPrioritario) {
        return candidatoPrioritario.url;
      }

      // Prioridade 2: Qualquer arquivo cujo título/nome termine em .pdf
      const candidatoPdf = arquivosAtivos.find((arq) => {
        const nome = (arq.nomeArquivo ?? arq.tituloArquivo ?? arq.titulo ?? "").toLowerCase();
        return nome.endsWith(".pdf");
      });

      if (candidatoPdf) {
        return candidatoPdf.url;
      }

      // Fallback: Primeiro arquivo ativo disponível
      return arquivosAtivos[0]?.url ?? null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[PncpService] Falha ao consultar anexos para ${cnpj}/${ano}/${sequencial}: ${message}`,
      );
      return null;
    }
  }
}

