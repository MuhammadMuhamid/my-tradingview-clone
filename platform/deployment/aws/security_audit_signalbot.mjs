import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

const EXPECTED_HASH = "1ead2e165543f986aad90dd1269bb92f49527733f20b2a9216a14d423bcdf39d";
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const prisma = new PrismaClient();
const bots = await prisma.signalBot.findMany();
const matching = bots.filter((b) => hash(b.webhookSecret) === EXPECTED_HASH);
const logs = await prisma.webhookLog.findMany({ select: { payload: true, status: true, createdAt: true } });
const secretInLogs = logs.filter((l) => {
  try { const p = JSON.parse(l.payload); return typeof p.secret === "string" && p.secret.length > 0; }
  catch { return l.payload.includes("\"secret\""); }
}).length;
const recentErrors = logs.filter((l) => l.status === "error" && l.createdAt > new Date(Date.now()-24*60*60*1000)).length;
const accounts = await prisma.exchangeAccount.findMany({ select: { apiKeyEnc: true, apiSecretEnc: true } });
const activeTrades = await prisma.smartTrade.count({ where: { status: "active" } });
const failures = [];
if (matching.length !== 1) failures.push(`expected exactly one bot matching supplied secret; found ${matching.length}`);
if (secretInLogs) failures.push(`${secretInLogs} webhook logs contain a secret field`);
if (accounts.some((a) => !a.apiKeyEnc || !a.apiSecretEnc)) failures.push("one or more exchange accounts lacks encrypted credentials");
const bot = matching[0];
console.log(JSON.stringify({
  matchingBots: matching.length,
  bot: bot ? {
    id: bot.id, name: bot.name, status: bot.status, entryEnabled: bot.entryEnabled,
    exitEnabled: bot.exitEnabled, maxActiveSmartTradesEnabled: bot.maxActiveSmartTradesEnabled,
    maxActiveSmartTrades: bot.maxActiveSmartTrades, maxInvestmentPct: bot.maxInvestmentPct,
    maxInvestmentUnit: bot.maxInvestmentUnit, pairs: JSON.parse(bot.pairs),
  } : null,
  exchangeAccounts: accounts.length,
  activeTrades,
  webhookLogs: logs.length,
  webhookErrorsLast24h: recentErrors,
  secretFieldsInLogs: secretInLogs,
  failures,
}, null, 2));
await prisma.$disconnect();
