/**
 * Web Push subscription plumbing.
 *
 * Flow: register the service worker → fetch the server's VAPID public key →
 * ask the browser to subscribe → hand the resulting endpoint to the backend,
 * which is what actually pushes when an MA alert fires.
 *
 * iOS caveat worth surfacing in the UI: Safari only grants push to a site the
 * user has added to the Home Screen. `pushSupported()` is true there before
 * installation, but `Notification.requestPermission()` will refuse — hence
 * `iosNeedsInstall()`.
 */
import { api } from "@/lib/api";

export type PushState = "unsupported" | "needs-install" | "denied" | "default" | "granted";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** iOS/iPadOS Safari that has not been installed to the Home Screen yet. */
export function iosNeedsInstall(): boolean {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports as a Mac; the touch points give it away.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!isIos) return false;
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  return !standalone;
}

export function pushState(): PushState {
  if (!pushSupported()) return iosNeedsInstall() ? "needs-install" : "unsupported";
  if (iosNeedsInstall()) return "needs-install";
  return Notification.permission as PushState;
}

/**
 * Whether THIS browser holds a push subscription.
 *
 * Permission and subscription are different facts, and conflating them left a
 * desktop browser unable to enrol at all: permission survives in the browser
 * long after the subscription is gone (or was never made on this device), so
 * `pushState()` read "granted", the UI offered only Test/Off, and there was no
 * way to reach Enable. A device is registered only if it has a subscription
 * object of its own — nothing about the server's total says anything about
 * this machine.
 */
export async function subscribedHere(): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    return (await registration?.pushManager.getSubscription()) != null;
  } catch {
    return false;
  }
}

/** VAPID keys travel as base64url; PushManager wants raw bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  // Backed by an explicit ArrayBuffer: PushManager's applicationServerKey is
  // typed as BufferSource, which excludes SharedArrayBuffer-backed views.
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function ready(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

/**
 * Idempotent: returns the existing subscription if the browser already has
 * one, but re-POSTs it either way so a database that was reset still learns
 * about a device that never revoked permission.
 */
export async function enablePush(): Promise<{ devices: number }> {
  if (!pushSupported()) throw new Error("This browser does not support push notifications.");
  if (iosNeedsInstall()) {
    throw new Error("On iPhone, use Share → Add to Home Screen first, then enable notifications from the installed app.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }
  const registration = await ready();
  const { publicKey } = await api.vapidKey();
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));
  return api.subscribePush(subscription.toJSON() as PushSubscriptionJSON);
}

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await api.unsubscribePush(subscription.endpoint);
  await subscription.unsubscribe();
}
