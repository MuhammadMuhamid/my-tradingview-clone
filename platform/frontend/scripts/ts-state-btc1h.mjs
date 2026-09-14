/** Put the focused pane on BINANCE BTCUSDT at 1h, through the product's own controls. */
export default async function (page) {
  const symbol = page.locator('button[aria-label^="Change symbol"]').first();
  const current = (await symbol.textContent()) ?? "";
  if (!/BTCUSDT|BTC\/USDT/.test(current)) {
    await symbol.click();
    const box = page.getByRole("dialog", { name: "Symbol search" }).locator("input").first();
    await box.fill("BTCUSDT");
    await page.waitForTimeout(600);
    const row = page.getByRole("dialog", { name: "Symbol search" }).locator('button, [role="option"], [role="row"]').filter({ hasText: /^BTC\s*\/?\s*USDT|BTCUSDT/ }).first();
    await row.click();
    await page.waitForTimeout(800);
  }
  const chip = page.getByRole("group", { name: "Timeframe" }).getByRole("button", { name: /^1h$/ }).first();
  if ((await chip.count()) && (await chip.getAttribute("aria-pressed")) !== "true") { await chip.click(); await page.waitForTimeout(800); }
  // Wait for the window to actually arrive: the pane says "showing … until it
  // arrives" while the previous symbol's bars are still on screen.
  await page.locator('text=/until it arrives/').first().waitFor({ state: "hidden", timeout: 30_000 }).catch(() => {});
  await page.locator('text=/loading…/').first().waitFor({ state: "hidden", timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1500);
}
