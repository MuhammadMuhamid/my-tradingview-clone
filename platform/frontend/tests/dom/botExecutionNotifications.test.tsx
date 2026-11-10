/**
 * P-81 on /bot: the Execution notifications card.
 *
 * The opt-in is a server preference (PUT /api/bot/notifications); device
 * permission is separate and stated honestly, including when the browser
 * cannot receive push or has blocked it. An older Bot without the feed is
 * named, and the recent list labels environments (REAL only for MAINNET).
 * No real push service is touched.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, screen } from "@testing-library/react";
import { closeBrowser, render, resetBrowser, server, settle } from "./harness/env";
import { AppRoute } from "./harness/routing";
import BotPage from "@/app/bot/page";
import { resetSessionForTests } from "@/lib/session";
import { account, botFixtures, NOTIFICATIONS } from "./botFixtures";

beforeEach(() => { resetBrowser(); resetSessionForTests(); });
after(closeBrowser);

const body = () => document.body.textContent ?? "";

test("admin opts in and out; the request carries only the preference", async () => {
  account("admin");
  botFixtures();
  let state = { ...NOTIFICATIONS };
  server.routes.set("GET /api/bot/notifications", () => state);
  server.routes.set("PUT /api/bot/notifications", (reqBody) => {
    state = { ...state, enabled: (reqBody as { enabled: boolean }).enabled };
    return { enabled: state.enabled, devices: 0 };
  });
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.ok(screen.getByRole("heading", { name: "Execution notifications" }));
  const box = screen.getByRole("checkbox", { name: "Notify me about confirmed Bot executions" }) as HTMLInputElement;
  assert.equal(box.checked, false);
  fireEvent.click(box);
  await settle(6);
  const put = server.calls.filter((c) => c.method === "PUT" && c.path === "/api/bot/notifications");
  assert.equal(put.length, 1);
  assert.deepEqual(put[0]!.body, { enabled: true });
  assert.equal((screen.getByRole("checkbox", { name: "Notify me about confirmed Bot executions" }) as HTMLInputElement).checked, true);
  // Opted in with no registered device: said, not hidden.
  assert.ok(body().includes("no device is registered for push yet"));
  // jsdom has no service worker / PushManager: capability is disclosed, not promised.
  assert.ok(screen.getByTestId("exec-notify-device").textContent?.includes("can't receive push notifications"));
});

test("an older Bot without the execution feed is named, and the recent list labels environments", async () => {
  account("admin");
  botFixtures();
  server.routes.set("GET /api/bot/notifications", () => ({
    ...NOTIFICATIONS, botFeed: "no", enabled: true, devices: 1,
    recent: [
      { eventId: "exit:a", side: "SELL", symbol: "BTCUSDT", environment: "MAINNET", executedBaseQty: 0.5,
        averagePrice: 64000, source: "tpsl", orderComplete: true, executedAt: "2026-11-09T10:00:00.000Z", notified: "sent" },
      { eventId: "manual:b:1", side: "BUY", symbol: "ETHUSDT", environment: "UNKNOWN", executedBaseQty: 0.1,
        averagePrice: 3000, source: "manual", orderComplete: false, executedAt: "2026-11-09T09:00:00.000Z", notified: null },
    ],
  }));
  render(<AppRoute path="/bot"><BotPage /></AppRoute>);
  await settle(6);
  assert.ok(body().includes("older version without the execution feed"));
  const recent = screen.getByTestId("exec-notify-recent").textContent ?? "";
  assert.ok(recent.includes("REAL"));
  assert.ok(recent.includes("UNKNOWN"));
  assert.ok(recent.includes("partial fill"));
  assert.equal(recent.includes("MAINNET"), false, "people see REAL, never the internal word");
});

test("blocked browser permission is explained", async () => {
  account("admin");
  botFixtures();
  const w = window as unknown as Record<string, unknown>;
  const nav = navigator as unknown as Record<string, unknown>;
  const g = globalThis as unknown as Record<string, unknown>;
  const denied = { permission: "denied", requestPermission: async () => "denied" };
  w.PushManager = function PushManager() {};
  w.Notification = denied;
  g.Notification = denied;
  Object.defineProperty(navigator, "serviceWorker", { configurable: true,
    value: { getRegistration: async () => undefined } });
  try {
    render(<AppRoute path="/bot"><BotPage /></AppRoute>);
    await settle(6);
    assert.ok(screen.getByTestId("exec-notify-device").textContent?.includes("blocked for this site"));
    assert.equal(screen.queryByRole("button", { name: "Enable on this device" }), null);
  } finally {
    delete w.PushManager;
    delete w.Notification;
    delete g.Notification;
    delete nav.serviceWorker;
  }
});
