import crypto from "node:crypto";
import pg from "pg";

const expectedSecretHash = "1ead2e165543f986aad90dd1269bb92f49527733f20b2a9216a14d423bcdf39d";
const expectedHashes = {
  "ZECUSDT": "25b098b9a360dcae1d31d80d2db1ad41d44a3bdb15ad9ca821483a63daffd42e",
  "DEXEUSDT": "bfe8223391661ba2738bd263ca3b96d02bd6d86496a2afe4a33ca44e7ad06ff3",
  "PUMPUSDT": "a1405079c5ea4a098bf583d2d75b90f176ceba622854e2d69fd09adc9fd8d5cd",
  "SYNUSDT": "3848b05fa2741a5b94b18e03317b611c19e1faacd055a217a0fa7f3c12cbf8dc",
  "KAITOUSDT": "7ab4776cd9c5acbccb2fd487e732e01d5f604937075bcb0453ba75217c86253c",
  "JTOUSDT": "a79b2c628acede85bc79da17f5fd586204365ba0b6eca0718c78024a780514bc",
  "币安人生USDT": "65c4ca280d987fe4718e90ce3adfea74fe3788cd2dc329a33fcafe3e1c54efb6",
  "TAOUSDT": "0ee18a0ee15c6159bc6ea76eba6a3c55e658417802675a676ca52d7f0278ce79",
  "JSTUSDT": "1b9ba3a7fea28db17140263afe3c5e9cda6f93db35b493947f88bd4cfc50d78e",
  "TIAUSDT": "86c8e8fbe8c5f89abdd6c661ff09618f7efc1c35964571e3cc20e6bb3be9886f",
  "INJUSDT": "836f13e710315a62dd9c2a76bab9fbdb355fa3eecf5cc5ee6d18f6d850f20844",
  "ALLOUSDT": "ee700d0228c6d23b7b2f8d3c3d1cdc042523a289709d6c6a097f87f2b4ca58f2",
  "EIGENUSDT": "6908cf74fb126ed5cf2eaea410af9e0966a9cc8534a9d141faceea6ca6b5a3bb",
  "JUPUSDT": "bed22ec267d5807275c9f72af6588621c730d205dea6c1f3b5286e8b0ad95874",
  "PYTHUSDT": "12b2b2eefc49ab382bce7ef078d1119552ef42d932d660d89d4ac4dfa8aac3ce",
};
const expectedSymbols = Object.keys(expectedHashes);
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
};
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const configHash = (value) => hash(JSON.stringify(stable(value)));
const key = crypto.createHash("sha256").update(process.env.ALERT_ENCRYPTION_KEY ?? "").digest();
const decrypt = (value) => {
  if (!value?.startsWith("enc:")) return value;
  const raw = Buffer.from(value.slice(4), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
};

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { rows } = await pool.query(`
  SELECT d.symbol,d.timeframe,d.params deployment_params,d.status,d.delivery,
         d.webhook_url,d.secret,d.buy_quote_qty,d.runtime_state->>'position' position,
         s.key strategy_key,l.name layout_name,l.timeframe layout_timeframe,
         l.strategy_key layout_strategy,l.params layout_params
  FROM deployments d
  JOIN strategies s ON s.id=d.strategy_id
  LEFT JOIN chart_layouts l ON l.symbol=d.symbol
  ORDER BY d.symbol
`);
const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
const results = expectedSymbols.map((symbol) => {
  const row = bySymbol.get(symbol);
  const secretOk = row ? hash(decrypt(row.secret) ?? "") === expectedSecretHash : false;
  return {
    symbol,
    exists: Boolean(row),
    exactDeploymentParams: Boolean(row && configHash(row.deployment_params) === expectedHashes[symbol]),
    exactLayoutParams: Boolean(row && configHash(row.layout_params) === expectedHashes[symbol]),
    timeframe: row?.timeframe ?? null,
    strategy: row?.strategy_key ?? null,
    active: row?.status === "active",
    delivery: row?.delivery ?? null,
    webhookOk: row?.webhook_url === "https://bot.alphawebstudioz.com/api/webhooks/signal_bots",
    secretOk,
    encryptedAtRest: row?.secret?.startsWith("enc:") ?? false,
    amount: row ? Number(row.buy_quote_qty) : null,
    layout: row?.layout_name ?? null,
    layoutTimeframe: row?.layout_timeframe ?? null,
    layoutStrategy: row?.layout_strategy ?? null,
    position: row?.position ?? null,
    partial: row?.deployment_params?.rrUsePartialTp ?? null,
  };
});
const exact = results.filter((r) => r.exactDeploymentParams && r.exactLayoutParams);
const ready = results.filter((r) => r.exists && r.active && r.timeframe === "15m" &&
  r.strategy === "mtf_lean" && r.webhookOk && r.secretOk && r.encryptedAtRest && r.amount === 70.01 &&
  r.layoutTimeframe === "15m" && r.layoutStrategy === "mtf_lean");
console.log(JSON.stringify({
  checked: results.length,
  exactConfigCount: exact.length,
  liveReadyCount: ready.length,
  extraDeployments: rows.map((r) => r.symbol).filter((symbol) => !expectedSymbols.includes(symbol)),
  results,
}, null, 2));
await pool.end();
