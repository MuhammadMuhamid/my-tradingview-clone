/**
 * JSON stdin/stdout boundary for Research and deterministic fixture tooling.
 * The simulator remains in Platform; this file contains no market semantics.
 */
import process from "node:process";
import { runCanonicalBacktest, type CanonicalBacktestInput } from "../src/engine/canonicalMultiAssetBacktester";

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) throw new Error("canonical backtest input JSON is required on stdin");
  const result = runCanonicalBacktest(JSON.parse(raw) as CanonicalBacktestInput);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`canonical-backtest: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
