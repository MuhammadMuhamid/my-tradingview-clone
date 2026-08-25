/**
 * Install the built-in indicator library into the script table.
 *
 * Idempotent: `upsertScript` matches on lower(name), so re-running replaces a
 * shipped script's source in place rather than creating a second copy. A
 * script the user has renamed is therefore left alone, and one they have
 * edited under the original name is reset — which is what "reinstall the
 * built-ins" should do.
 *
 * Every script is compiled before it is written. A library entry that does not
 * parse would otherwise sit in the picker and fail only when someone adds it
 * to a chart.
 *
 *   local    : cd backend && npx tsx src/scripts/seedIndicatorLibrary.ts [--dry]
 *   deployed : docker exec <backend> node dist/scripts/seedIndicatorLibrary.js
 */
import { INDICATOR_LIBRARY } from "../pine/library";
import { PineInterpreter } from "../pine/interpreter";
import * as scripts from "../repositories/pineScripts";
import { closePool } from "../db/pool";

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  if (dry) console.log("DRY RUN — nothing will be written\n");

  let installed = 0;
  const failed: string[] = [];

  for (const entry of INDICATOR_LIBRARY) {
    const { meta, errors } = PineInterpreter.compile(entry.source);
    if (errors.length > 0) {
      failed.push(`${entry.name}: ${errors[0]!.message}`);
      console.log(`  SKIP  ${entry.name} — ${errors[0]!.message}`);
      continue;
    }
    if (!dry) {
      await scripts.upsertScript({ name: entry.name, source: entry.source, kind: meta.kind });
    }
    installed++;
    console.log(
      `  ok    ${entry.name.padEnd(38)} ${meta.kind}, ` +
      `${meta.inputs.length} input${meta.inputs.length === 1 ? "" : "s"}, ` +
      `${meta.overlay ? "on price" : "separate pane"}`
    );
  }

  console.log(`\n${installed}/${INDICATOR_LIBRARY.length} installed`);
  if (failed.length > 0) {
    // A library that ships a broken script is a bug, not a warning.
    console.error("\nFAILED TO COMPILE:");
    for (const f of failed) console.error("  " + f);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
