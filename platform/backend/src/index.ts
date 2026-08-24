import { config } from "./config";
import { migrate } from "./db/migrate";
import { closePool } from "./db/pool";
import { buildServer } from "./api/server";
import { startBacktestWorker } from "./engine/worker";
import { LiveRunner } from "./engine/liveRunner";
import { MaAlertRunner } from "./engine/maAlertRunner";
import { encryptLegacySecrets } from "./repositories/deployments";

async function main(): Promise<void> {
  const applied = await migrate();
  const encrypted = await encryptLegacySecrets();
  // The LiveRunner needs a logger; routes need the runner. Break the cycle with
  // a lazy getter — routes only touch the runner at request time, by when it exists.
  // Assigned below, after buildServer captures the getter. Not a const.
  // eslint-disable-next-line prefer-const
  let runner: LiveRunner | undefined;
  const app = buildServer(() => {
    if (!runner) throw new Error("live runner not initialized");
    return runner;
  });
  runner = new LiveRunner(app.log);
  if (applied.length > 0) {
    app.log.info({ applied }, "database migrations applied");
  }
  if (encrypted > 0) app.log.info({ encrypted }, "legacy deployment credentials encrypted");

  await app.listen({ host: config.host, port: config.port });

  if (process.env.WORKER_ENABLED !== "false") {
    startBacktestWorker(app.log);
    app.log.info("backtest worker started");
  }

  if (process.env.LIVE_RUNNER_ENABLED !== "false") {
    await runner.start();
  }

  // Independent of the strategy live runner: MA alerts must keep watching even
  // when no strategy deployment is active.
  let maAlerts: MaAlertRunner | undefined;
  if (process.env.MA_ALERTS_ENABLED !== "false") {
    maAlerts = new MaAlertRunner(app.log);
    await maAlerts.start();
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    runner?.stop();
    maAlerts?.stop();
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
