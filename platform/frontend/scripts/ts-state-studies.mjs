/** BTCUSDT 1h with RSI and MACD added through the Indicators dialog. */
import btc1h from "./ts-state-btc1h.mjs";
export default async function (page) {
  await btc1h(page);
  for (const name of ["Relative Strength Index", "MACD"]) {
    await page.locator('button[aria-label^="Indicators"]').first().click();
    const dialog = page.locator('[role="dialog"]').filter({ has: page.locator('input[aria-label="Search indicators"]') }).first();
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    await dialog.locator('input[aria-label="Search indicators"]').fill(name);
    await page.waitForTimeout(500);
    const add = dialog.locator(`button[title^="Add ${name} to"]`).first();
    if (await add.count()) await add.click();
    else await dialog.getByText(name, { exact: true }).first().click();
    await page.waitForTimeout(700);
    if (await dialog.isVisible().catch(() => false)) { await page.keyboard.press("Escape"); await page.waitForTimeout(300); }
  }
  await page.mouse.move(700, 500);
  await page.waitForTimeout(1500);
}
