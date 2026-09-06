/**
 * Install the built-in indicator library into the script table.
 *
 * The decision about what may be overwritten lives in `pine/librarySeed`,
 * because the backend runs it on boot as well and the two must not be able to
 * disagree about whose script is whose. This file is the command-line face of
 * it: arguments, output, and an exit code.
 *
 *   local    : cd backend && npx tsx src/scripts/seedIndicatorLibrary.ts [--dry]
 *   deployed : docker exec <backend> node dist/scripts/seedIndicatorLibrary.js
 */
import { seedIndicatorLibrary, LIBRARY_VERSION } from "../pine/librarySeed";
import { INDICATOR_LIBRARY } from "../pine/library";
import { closePool } from "../db/pool";

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  if (dry) console.log("DRY RUN — nothing will be written\n");

  const summary = await seedIndicatorLibrary({
    dryRun: dry,
    log: (message) => console.log(message),
  });

  console.log(
    `\nlibrary ${LIBRARY_VERSION}: ${summary.installed} installed, ` +
    `${summary.updated} updated, ${summary.unchanged} already current, ` +
    `${summary.kept} left alone, of ${INDICATOR_LIBRARY.length}`
  );
  if (summary.kept > 0) {
    // Said explicitly. A user who expected "reinstall the built-ins" to reset
    // their edits needs to know it deliberately did not.
    console.log("\nLEFT ALONE — these have been changed or authored here:");
    for (const r of summary.results) {
      if (r.outcome === "kept-user-edit" || r.outcome === "kept-user-script") {
        console.log(`  ${r.name.padEnd(38)} ${r.detail ?? ""}`);
      }
    }
  }
  if (summary.failed.length > 0) {
    // A library that ships a broken script is a bug, not a warning.
    console.error("\nFAILED TO COMPILE:");
    for (const f of summary.failed) console.error("  " + f);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
