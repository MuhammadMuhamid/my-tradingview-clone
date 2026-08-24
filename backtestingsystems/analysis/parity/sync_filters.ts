import { syncExchangeFilters } from "../src/data/binanceRest";
import { closePool } from "../src/db/pool";
const coins = ["DEXEUSDT","MORPHOUSDT","INJUSDT","NEARUSDT","JTOUSDT","ZECUSDT","PUMPUSDT","APTUSDT","ARBUSDT","PYTHUSDT","ALGOUSDT","TAOUSDT","ENAUSDT","JUPUSDT","TIAUSDT","BTCUSDT"];
syncExchangeFilters(coins).then(async () => { console.log("filters synced"); await closePool(); });
