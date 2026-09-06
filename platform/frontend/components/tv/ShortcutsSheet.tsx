"use client";
/**
 * The keyboard shortcuts, listed from the table that implements them.
 *
 * ── Why it reads the table ─────────────────────────────────────────────────
 *
 * A hand-written list of shortcuts is a list that is wrong within two changes,
 * and wrong in the worst direction: it advertises keys that do nothing and
 * omits keys that do. This renders `BINDINGS` itself, so the sheet cannot
 * describe a shortcut the product does not have, and a shortcut added to the
 * table appears here without anyone remembering to add it.
 *
 * The modifier is shown as the platform's own — ⌘ on a Mac, Ctrl elsewhere —
 * because a sheet that says "Ctrl+Z" on a Mac is telling the reader to press a
 * key combination that does nothing.
 */
import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { BINDINGS, isMacPlatform, type Binding } from "@/lib/shortcuts";

const GROUP_ORDER: Binding["group"][] = [
  "Edit", "Drawing tools", "Chart", "Replay", "Navigation",
];

/** How one binding is written on a key cap. */
function keyLabel(binding: Binding, mac: boolean): string {
  const parts: string[] = [];
  if (binding.mod) parts.push(mac ? "⌘" : "Ctrl");
  if (binding.shift) parts.push(mac ? "⇧" : "Shift");
  parts.push(prettyKey(binding.key));
  return parts.join(mac ? "" : "+");
}

function prettyKey(key: string): string {
  switch (key) {
    case " ": return "Space";
    case "ArrowLeft": return "←";
    case "ArrowRight": return "→";
    case "Escape": return "Esc";
    case "Delete": return "Del";
    case "Backspace": return "⌫";
    default: return key.length === 1 ? key.toUpperCase() : key;
  }
}

export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  // After mount, so the server-rendered markup and the first client render
  // agree; the platform is only knowable in the browser.
  const [mac, setMac] = useState(false);
  useEffect(() => { setMac(isMacPlatform()); }, []);

  /*
   * Several actions have two bindings (Redo is ⌘⇧Z and ⌘Y). Showing one row
   * per binding would list Redo twice; showing one row per ACTION with both
   * keys is what the reader is actually asking for.
   */
  const groups = useMemo(() => {
    const byGroup = new Map<Binding["group"], { label: string; keys: string[] }[]>();
    for (const binding of BINDINGS) {
      const rows = byGroup.get(binding.group) ?? [];
      const existing = rows.find((row) => row.label === binding.label);
      if (existing) existing.keys.push(keyLabel(binding, mac));
      else rows.push({ label: binding.label, keys: [keyLabel(binding, mac)] });
      byGroup.set(binding.group, rows);
    }
    return GROUP_ORDER
      .filter((group) => byGroup.has(group))
      .map((group) => ({ group, rows: byGroup.get(group)! }));
  }, [mac]);

  return (
    <Modal open={open} onClose={onClose} wide title="Keyboard shortcuts">
      <div className="grid gap-5 sm:grid-cols-2">
        {groups.map(({ group, rows }) => (
          <section key={group}>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
              {group}
            </h3>
            <dl className="space-y-1">
              {rows.map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-3">
                  <dt className="min-w-0 flex-1 truncate text-[13px] text-ink">{row.label}</dt>
                  <dd className="flex shrink-0 gap-1">
                    {row.keys.map((key) => (
                      <kbd key={key}
                        className="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-muted">
                        {key}
                      </kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            Timeframe
          </h3>
          <p className="text-[13px] text-ink-muted">
            Type a number and press Enter — <span className="text-ink">15</span> for 15
            minutes, <span className="text-ink">60</span> or{" "}
            <span className="text-ink">1h</span> for an hour,{" "}
            <span className="text-ink">1d</span> for a day. Only timeframes this
            installation serves are accepted; anything else clears the entry rather
            than picking the nearest.
          </p>
        </section>
      </div>
      <p className="mt-4 border-t border-border pt-3 text-xs text-ink-faint">
        Shortcuts never fire while you are typing — in a field, a text area, a
        dropdown or the Pine editor, every key belongs to what you are typing into.
      </p>
    </Modal>
  );
}
