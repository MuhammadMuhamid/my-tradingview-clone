"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/Modal";
import { GROUPS } from "./DrawingToolbar";
import {
  buildCommands, rankCommands, runCommand,
  type Command, type CommandContext, type CommandHandlers,
} from "@/lib/commandPalette";
import { isMacPlatform } from "@/lib/shortcuts";

/**
 * "Search tool or function" — the workstation's command palette.
 *
 * TVP8. The reference has one, behind the magnifier beside the settings gear,
 * and the previous campaign's ledger recorded it as not-applicable. It is the
 * answer to a question this product asks more often than the reference does:
 * there are 87 drawing tools behind eight flyouts, 57 studies behind a browser,
 * 21 chart types behind one menu and about forty keyboard actions, and knowing
 * that "Fib wedge" exists is not the same as knowing which flyout it is in.
 *
 * The ranking lives in `lib/commandPalette.ts` and is tested there. This file
 * is the dialog: a field, a list, and the keyboard.
 */

const FAVOURITES_KEY = "tv.commandFavourites.v1";

function readFavourites(): string[] {
  try {
    const raw = window.localStorage.getItem(FAVOURITES_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch { return []; }
}

export function CommandPalette({
  open, onClose, handlers, context,
}: {
  open: boolean;
  onClose: () => void;
  handlers: CommandHandlers;
  /** What can act right now — see `buildCommands`. */
  context: CommandContext;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [favourites, setFavourites] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const mac = isMacPlatform();
  /*
   * The two flags, not the object: the caller builds `context` inline, so a
   * dependency on its identity would rebuild all 165 commands on every render
   * of the chart page.
   */
  const { replayActive, drawingSelected } = context;
  const commands = useMemo(
    () => buildCommands(GROUPS, mac, { replayActive, drawingSelected }),
    [mac, replayActive, drawingSelected]);
  const results = useMemo(
    () => rankCommands(commands, query, favourites).slice(0, 60),
    [commands, query, favourites]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    setFavourites(readFavourites());
    // The field, not the first row: a palette exists to be typed into.
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  // A new query invalidates the cursor's position, not its intent.
  useEffect(() => { setCursor(0); }, [query]);

  // Keep the cursor row in view when it moves past the fold.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const toggleFavourite = (id: string): void => {
    setFavourites((current) => {
      const next = current.includes(id)
        ? current.filter((f) => f !== id)
        : [...current, id];
      try { window.localStorage.setItem(FAVOURITES_KEY, JSON.stringify(next)); }
      catch { /* private window: the palette still works, it just forgets */ }
      return next;
    });
  };

  const choose = (command: Command): void => {
    runCommand(command, handlers);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const command = results[cursor];
      if (command) choose(command);
    }
  };

  /* Section headings, as the reference draws them: the group changes and a
     small uppercase label announces the new one. */
  let lastGroup: string | null = null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Search tool or function"
      panelClassName="w-[min(680px,calc(100vw-32px))]"
      contentClassName="p-0"
    >
      <div onKeyDown={onKeyDown}>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.8" className="shrink-0 text-ink-faint" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type to search for drawings, indicators, chart types and settings"
            aria-label="Search tool or function"
            role="combobox"
            aria-expanded
            aria-controls="command-palette-results"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          />
        </div>

        <div
          ref={listRef}
          id="command-palette-results"
          role="listbox"
          aria-label="Results"
          className="max-h-[420px] overflow-y-auto py-1"
        >
          {results.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-ink-muted">
              Nothing matches “{query}”.
            </p>
          )}
          {results.map((command, index) => {
            const heading = command.group !== lastGroup ? command.group : null;
            lastGroup = command.group;
            const isFavourite = favourites.includes(command.id);
            return (
              <div key={command.id}>
                {heading && (
                  <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                    {heading}
                  </div>
                )}
                <div
                  data-index={index}
                  role="option"
                  aria-selected={index === cursor}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => choose(command)}
                  className={`tvc-menu-row flex cursor-pointer items-center gap-2 px-3 text-sm ${
                    index === cursor ? "bg-state-active text-ink" : "text-ink-muted"}`}
                >
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); toggleFavourite(command.id); }}
                    aria-label={isFavourite
                      ? `Remove ${command.label} from favourites`
                      : `Add ${command.label} to favourites`}
                    aria-pressed={isFavourite}
                    className="shrink-0 text-ink-faint hover:text-ink"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" strokeWidth="1.7"
                      fill={isFavourite ? "currentColor" : "none"} stroke="currentColor"
                      aria-hidden="true">
                      <path d="M12 3l2.6 5.6 6 .8-4.4 4.2 1.1 6.1L12 16.8 6.7 19.7l1.1-6.1L3.4 9.4l6-.8z" />
                    </svg>
                  </button>
                  <span className="min-w-0 flex-1 truncate">{command.label}</span>
                  {command.shortcut && (
                    <span className="shrink-0 text-[11px] tabular text-ink-faint">
                      {command.shortcut}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
