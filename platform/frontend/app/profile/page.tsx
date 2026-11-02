"use client";
/**
 * Profile settings: who you are, how you sign in, and the account itself.
 *
 * Laid out as TradingView's settings pages are: a section list on the left, the
 * section on the right, each change saved by its own button.
 */
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { refreshSession, signOut, useSession } from "@/lib/session";
import { PRODUCT_NAME } from "@/lib/navigation";
import { Avatar, GoogleMark, ProductMark } from "@/components/AuthShell";
import { Button, Card as Panel, CardHeader, PageHeader, TextInput } from "@/components/ui";

type Section = "profile" | "security" | "account";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "profile", label: "Public profile" },
  { id: "security", label: "Password & sign-in" },
  { id: "account", label: "Account" },
];

async function send(path: string, method: string, body?: unknown): Promise<{ error?: string }> {
  const res = await fetch(path, {
    method, credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

/**
 * A section, on the shared card: `--ts-surface`, the strong outer line, radius
 * 6 and the 14px `CardHeader` — the surface every other page's sections use.
 * This page used to draw its own (radius 8, `surface-2`, a 15px heading), a
 * second product's card inside the first.
 */
function Card({ title, children, danger }: { title: string; children: ReactNode; danger?: boolean }) {
  return (
    <Panel>
      <CardHeader title={danger ? <span className="text-down">{title}</span> : title} />
      <div className="p-4">{children}</div>
    </Panel>
  );
}

function Notice({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <p role={ok ? "status" : "alert"} className={`mt-3 text-[13px] ${ok ? "text-up" : "text-down"}`}>{children}</p>
  );
}

export default function ProfilePage() {
  const session = useSession();
  const user = session?.user ?? null;
  const [section, setSection] = useState<Section>("profile");

  const [name, setName] = useState("");
  const [nameMsg, setNameMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [current, setCurrent] = useState("");
  const [fresh, setFresh] = useState("");
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState("");
  const [delMsg, setDelMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (user) setName(user.displayName); }, [user?.id, user?.displayName]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!session) return <div className="ts-app min-h-screen bg-surface" />;
  if (!user) {
    return (
      <div className="ts-app flex min-h-screen items-center justify-center bg-surface text-ink-muted">
        <Link href="/login?next=/profile" className="text-accent hover:underline">Sign in to see your profile</Link>
      </div>
    );
  }

  const saveName = async (): Promise<void> => {
    setBusy(true); setNameMsg(null);
    try {
      await send("/api/auth/profile", "PATCH", { displayName: name });
      await refreshSession();
      setNameMsg({ ok: true, text: "Saved." });
    } catch (e) { setNameMsg({ ok: false, text: (e as Error).message }); }
    setBusy(false);
  };

  const savePassword = async (): Promise<void> => {
    setBusy(true); setPwMsg(null);
    try {
      await send("/api/auth/password", "POST",
        user.hasPassword ? { currentPassword: current, newPassword: fresh } : { newPassword: fresh });
      setCurrent(""); setFresh("");
      await refreshSession();
      setPwMsg({ ok: true, text: "Password saved. Your other devices have been signed out." });
    } catch (e) { setPwMsg({ ok: false, text: (e as Error).message }); }
    setBusy(false);
  };

  const deleteAccount = async (): Promise<void> => {
    setBusy(true); setDelMsg(null);
    try {
      await send("/api/auth/account", "DELETE", { confirm });
      window.location.href = "/login";
    } catch (e) { setDelMsg((e as Error).message); setBusy(false); }
  };

  const admin = user.role === "admin";
  const since = new Date(user.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  return (
    <div className="ts-app min-h-screen bg-surface text-ink">
      <header className="flex h-12 items-center gap-3 border-b border-border px-4">
        <Link href="/chart" className="flex items-center gap-2" aria-label={`${PRODUCT_NAME} chart`}>
          <ProductMark size={22} />
          <span className="text-[15px] font-semibold">{PRODUCT_NAME}</span>
        </Link>
        <span className="flex-1" />
        <Link href="/chart" className="rounded-md px-3 py-1.5 text-[13px] text-ink-muted hover:bg-state-hover hover:text-ink">
          Back to chart
        </Link>
      </header>

      <div className="ts-app mx-auto flex max-w-[1000px] flex-col gap-6 px-4 py-8 md:flex-row">
        <aside className="md:w-[240px] md:shrink-0">
          <div className="flex items-center gap-3 px-2">
            <Avatar name={user.displayName} url={user.avatarUrl} size={48} />
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold">{user.displayName}</div>
              <div className="truncate text-[12px] text-ink-faint">{user.email ?? (admin ? "Administrator" : "")}</div>
            </div>
          </div>
          <nav className="mt-5 flex gap-1 overflow-x-auto md:flex-col" aria-label="Profile sections">
            {SECTIONS.map((s) => (
              <button key={s.id} type="button" onClick={() => setSection(s.id)}
                aria-current={section === s.id ? "page" : undefined}
                className={`shrink-0 rounded-md px-3 py-2 text-left text-[14px] ${
                  section === s.id ? "bg-surface-2 font-medium text-ink" : "text-ink-muted hover:bg-state-hover hover:text-ink"
                }`}>
                {s.label}
              </button>
            ))}
            <button type="button" onClick={() => void signOut()}
              className="shrink-0 rounded-md px-3 py-2 text-left text-[14px] text-down hover:bg-state-hover md:mt-3">
              Sign out
            </button>
          </nav>
        </aside>

        <main className="min-w-0 flex-1 space-y-5">
          <PageHeader title="Profile" />
          {section === "profile" && (
            <Card title="Public profile">
              <div className="flex items-center gap-4">
                <Avatar name={name || user.displayName} url={user.avatarUrl} size={64} />
                <p className="text-[13px] text-ink-muted">
                  {user.avatarUrl ? "Your picture comes from your Google account." : "Link Google to use your Google picture."}
                </p>
              </div>
              <label className="mt-5 block text-[13px] text-ink-muted" htmlFor="display-name">Display name</label>
              <TextInput id="display-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)}
                className="mt-1.5 block w-full max-w-sm" />
              <div className="mt-4">
                <Button variant="primary" disabled={busy || !name.trim() || name.trim() === user.displayName}
                  onClick={() => void saveName()}>Save</Button>
              </div>
              {nameMsg && <Notice ok={nameMsg.ok}>{nameMsg.text}</Notice>}
              <dl className="mt-6 grid max-w-sm grid-cols-[120px_1fr] gap-y-2 text-[13px]">
                <dt className="text-ink-faint">Email</dt><dd className="truncate">{user.email ?? "—"}</dd>
                <dt className="text-ink-faint">Account type</dt>
                <dd>
                  {admin ? "Administrator" : "Standard"}
                  {/* Say what the type gives, so nobody has to find out from a refusal. */}
                  <span className="mt-0.5 block text-[12px] text-ink-faint">
                    {admin
                      ? "Everything, including trading, automations, the Journal and research tools."
                      : "Charts, Screener, alerts, watchlists, layouts, Pine scripts and the Shariah screen. Trading, automations, the Journal and research tools belong to the administrator."}
                  </span>
                </dd>
                <dt className="text-ink-faint">Member since</dt><dd>{since}</dd>
              </dl>
            </Card>
          )}

          {section === "security" && (
            <>
              <Card title="Password">
                {user.passwordManagedByServer ? (
                  <p className="text-[13px] text-ink-muted">
                    The administrator&apos;s password is set on the server (ADMIN_PASSWORD_HASH), not here.
                  </p>
                ) : (
                  <form onSubmit={(e) => { e.preventDefault(); void savePassword(); }} className="max-w-sm">
                    {user.hasPassword ? (
                      <>
                        <label className="block text-[13px] text-ink-muted" htmlFor="current">Current password</label>
                        <TextInput id="current" type="password" autoComplete="current-password" value={current}
                          onChange={(e) => setCurrent(e.target.value)} className="mt-1.5 block w-full" />
                      </>
                    ) : (
                      <p className="text-[13px] text-ink-muted">
                        You sign in with Google. Set a password to sign in with your email too.
                      </p>
                    )}
                    <label className="mt-4 block text-[13px] text-ink-muted" htmlFor="new">New password</label>
                    <TextInput id="new" type="password" autoComplete="new-password" value={fresh}
                      onChange={(e) => setFresh(e.target.value)} className="mt-1.5 block w-full" />
                    <p className="mt-1.5 text-[12px] text-ink-faint">At least 8 characters.</p>
                    <div className="mt-4">
                      <Button type="submit" variant="primary" disabled={busy || fresh.length < 8 || (user.hasPassword && !current)}>
                        {user.hasPassword ? "Change password" : "Set password"}
                      </Button>
                    </div>
                    {pwMsg && <Notice ok={pwMsg.ok}>{pwMsg.text}</Notice>}
                  </form>
                )}
              </Card>

              <Card title="Google">
                <div className="flex flex-wrap items-center gap-3">
                  <GoogleMark />
                  <span className="text-[14px]">
                    {user.googleLinked ? "Linked — you can sign in with Google." : "Not linked."}
                  </span>
                  {!user.googleLinked && session.providers.google && (
                    <a href="/api/auth/google/start?mode=link&next=/profile">
                      <Button>Link Google account</Button>
                    </a>
                  )}
                </div>
                {!session.providers.google && !user.googleLinked && (
                  <p className="mt-2 text-[12px] text-ink-faint">Google sign-in is not configured on this server.</p>
                )}
              </Card>

              <Card title="Sessions">
                <p className="text-[13px] text-ink-muted">
                  Signed in on a computer you no longer use? Sign out of every device, this one included.
                </p>
                <div className="mt-4">
                  <Button onClick={() => void signOut(true)}>Sign out everywhere</Button>
                </div>
              </Card>
            </>
          )}

          {section === "account" && (
            <Card title="Delete account" danger>
              {admin ? (
                <p className="text-[13px] text-ink-muted">The administrator account cannot be deleted.</p>
              ) : (
                <>
                  <p className="text-[13px] text-ink-muted">
                    Deletes your account and everything in it — alerts, watchlists, layouts, drawings and scripts.
                    This cannot be undone.
                  </p>
                  <label className="mt-4 block text-[13px] text-ink-muted" htmlFor="confirm">Type DELETE to confirm</label>
                  <TextInput id="confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                    className="mt-1.5 block w-full max-w-xs" />
                  <div className="mt-4">
                    <Button variant="danger" disabled={busy || confirm !== "DELETE"} onClick={() => void deleteAccount()}>
                      Delete my account
                    </Button>
                  </div>
                  {delMsg && <Notice ok={false}>{delMsg}</Notice>}
                </>
              )}
            </Card>
          )}
        </main>
      </div>
    </div>
  );
}
