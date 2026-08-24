// Worker bootstrap: register the tsx loader, then load the TS worker module.
import { register } from "tsx/esm/api";
register();
await import("./evalWorker.ts");
