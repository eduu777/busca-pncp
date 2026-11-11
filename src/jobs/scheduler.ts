import cron, { ScheduledTask } from "node-cron";
import { LicitacaoService } from "../services/licitacao.service";

const DEFAULT_CRON_EXPRESSION = "0 6,18 * * *"; // Às 06:00 e às 18:00 todos os dias
const DEFAULT_TIMEZONE = "America/Fortaleza";

export class SchedulerJob {
  private readonly licitacaoService: LicitacaoService;
  private readonly cronExpression: string;
  private readonly timezone: string;
  private task: ScheduledTask | null = null;
  private emExecucao = false;

  constructor(licitacaoService?: LicitacaoService) {
    this.licitacaoService = licitacaoService ?? new LicitacaoService();
    this.cronExpression = process.env.CRON_SCHEDULE ?? DEFAULT_CRON_EXPRESSION;
    this.timezone = process.env.CRON_TIMEZONE ?? DEFAULT_TIMEZONE;
  }

  /**
   * Executa o pipeline garantindo exclusão mútua (evita sobreposição de jobs).
   */
  public async executarCiclo(origem: "INICIAL" | "CRON"): Promise<void> {
    if (this.emExecucao) {
      console.warn(
        `[Scheduler] Execução (${origem}) ignorada: já existe um ciclo do pipeline em andamento.`,
      );
      return;
    }

    this.emExecucao = true;
    const inicio = Date.now();
    console.log(
      `\n================================================================================`,
    );
    console.log(
      `[Scheduler] Iniciando ciclo [${origem}] em ${new Date().toISOString()}`,
    );
    console.log(
      `================================================================================`,
    );

    try {
      await this.licitacaoService.executarPipeline();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Scheduler] Erro não tratado no ciclo [${origem}]: ${message}`);
    } finally {
      this.emExecucao = false;
      const duracaoSegundos = ((Date.now() - inicio) / 1000).toFixed(2);
      console.log(`[Scheduler] Ciclo [${origem}] finalizado em ${duracaoSegundos}s.`);
    }
  }

  /**
   * Registra e inicia o agendamento via `node-cron`.
   */
  public iniciarAgendamento(): void {
    if (!cron.validate(this.cronExpression)) {
      throw new Error(`[Scheduler] Expressão cron inválida: "${this.cronExpression}"`);
    }

    this.task = cron.schedule(
      this.cronExpression,
      () => {
        void this.executarCiclo("CRON");
      },
      {
        timezone: this.timezone,
      },
    );

    console.log(
      `[Scheduler] Agendamento ativo com expressão "${this.cronExpression}" (Timezone: ${this.timezone}).`,
    );
  }

  public pararAgendamento(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
      console.log("[Scheduler] Agendamento interrompido.");
    }
  }
}

