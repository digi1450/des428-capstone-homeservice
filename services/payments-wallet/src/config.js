export const serviceName = "payments-wallet";
export const schemaVersion = "001_initial.sql";

export function readConfig(env = process.env) {
  const port = Number(env.PORT ?? 3002);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { throw new Error("Invalid DATABASE_URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("PostgreSQL DATABASE_URL required");
  return { port, databaseUrl: env.DATABASE_URL };
}
