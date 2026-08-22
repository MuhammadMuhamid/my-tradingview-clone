/**
 * Service worker for MA price alerts.
 *
 * Its only job is push: it must exist and stay registered for the browser to
 * hold a push subscription at all, and it is what renders the notification
 * when the backend fires while the site is closed. Deliberately no fetch
 * handler — the app is server-rendered and caching it here would serve stale
 * chart code after a deploy.
 */

self.addEventListener("install", () => {
  // Take over immediately so a freshly registered worker can receive pushes
  // without the user having to reload the page first.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Price alert", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Price alert";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      // Same tag ⇒ the device replaces the previous notification for this alert
      // instead of stacking a new one on every bar.
      tag: data.tag || "ma-alert",
      renotify: true,
      timestamp: Date.now(),
      data: { url: data.url || "/chart" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/chart";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Reuse an already-open tab rather than piling up windows.
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
