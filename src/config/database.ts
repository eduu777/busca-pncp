import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { Pool, PoolClient } from "pg";

dotenv.config();

export const pool = new Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? "postgres",
  password: process.env.DB_PASSWORD ?? "",
  database: process.env.DB_NAME ?? "pncp_dados",
  max: Number(process.env.DB_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err: Error) => {
  console.error("[Database] Erro inesperado no cliente inativo do Pool:", err.message);
});

/**
 * Obtém um cliente do Pool para operações transacionais ou sequenciais.
 * O chamador DEVE invocar `client.release()` dentro de um bloco `finally`.
 */
export async function getDbClient(): Promise<PoolClient> {
  return pool.connect();
}

/**
 * Inicializa o schema do banco de dados executando `src/database/schema.sql`.
 */
export async function ensureSchema(): Promise<void> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    const schemaPath = path.resolve(__dirname, "..", "database", "schema.sql");
    if (fs.existsSync(schemaPath)) {
      const ddl = fs.readFileSync(schemaPath, "utf-8");
      await client.query(ddl);
      console.log("[Database] Schema verificado/aplicado com sucesso.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Database] Falha ao inicializar schema: ${message}`);
    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
}

