/**
 * Loader bootstrap for the Pine worker when the backend runs from TypeScript
 * source — `tsx` in development and under the test runner.
 *
 * A worker thread does not reliably inherit the parent's TypeScript loader.
 * The `--import tsx` preload does re-run inside the worker, but on Node 22 the
 * ESM hooks tsx installs through `module.register()` have no effect there, so
 * `runner.worker.ts` was handed to Node's own type stripping instead — and that
 * loader resolves strictly, rejecting the extensionless relative imports this
 * compiler configuration is built on (`ERR_MODULE_NOT_FOUND` on
 * `../engine/broker`). The thread died before running a line of Pine. Node
 * 24.11+ and 26 only appeared to work because tsx switches to the synchronous
 * `module.registerHooks()` there, which does apply per thread.
 *
 * This file is plain CommonJS, so every Node version loads it with no hooks at
 * all. It installs tsx's CommonJS require hook — in-thread patching of the
 * module loader, not loader registration — and only then requires the real
 * worker, which reads `workerData` and answers on `parentPort` as before.
 *
 * The compiled `dist/` build never comes through here: there the parent starts
 * `runner.worker.js` directly and no loader is involved.
 */
try {
  require("tsx/cjs/api").register();
} catch (err) {
  throw new Error(
    "the Pine worker runs from TypeScript source and needs the tsx require hook, " +
      `which could not be loaded (${err && err.code ? err.code : "unknown"}). ` +
      "Install devDependencies, or run the compiled build from dist/."
  );
}

require("./runner.worker.ts");
