import type { FastifyInstance } from "fastify";
import { query } from "../../db/pool";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    let db = false;
    try {
      await query("SELECT 1");
      db = true;
    } catch {
      // db stays false — the server itself is still up
    }
    return { ok: true, db, time: new Date().toISOString() };
  });
}
