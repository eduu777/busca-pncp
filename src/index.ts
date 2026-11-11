import dotenv from "dotenv";
import { ensureSchema, pool } from "./config/database";
import { SchedulerJob } from "./jobs/scheduler";

dotenv.config();

async function bootstrap(): Promise<void> {
  console.log("[App] Inicializando Agente de Monitoramento e Análise de Licitações (PNCP)...");

  try {
    await ensureSchema();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[App] Aviso: Não foi possível aplicar o schema automaticamente (${message}). Verifique a conexão com o PostgreSQL.`,
    );
  }

  const scheduler = new SchedulerJob();
  scheduler.iniciarAgendamento();

  // Dispara execução inicial imediata ao subir o serviço
  await scheduler.executarCiclo("INICIAL");

  const encerrarGraciosamente = async (sinal: string): Promise<void> => {
    console.log(`\n[App] Sinal ${sinal} recebido. Encerrando recursos...`);
    scheduler.pararAgendamento();
    try {
      await pool.end();
      console.log("[App] Pool PostgreSQL encerrado com sucesso.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[App] Erro ao encerrar pool do PostgreSQL: ${msg}`);
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => {
    void encerrarGraciosamente("SIGINT");
  });

  process.on("SIGTERM", () => {
    void encerrarGraciosamente("SIGTERM");
  });
}

void bootstrap();

