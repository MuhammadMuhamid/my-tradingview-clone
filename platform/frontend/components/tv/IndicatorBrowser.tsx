"use client";
/**
 * The Indicators dialog: everything this installation can put on a chart.
 *
 * ── What it is a browser OVER ──────────────────────────────────────────────
 *
 * Two real libraries, and nothing else.
 *
 * TECHNICALS: the native studies this build ships (`lib/native/catalog`). They
 * compute in the browser, from the bars the pane already holds, using the same
 * canonical maths the server alerts on. "Built-in" used to be an empty promise
 * here and is now a truthful heading — which is exactly why it was refused
 * before rather than shown as a stub.
 *
 * MY SCRIPTS: the Pine scripts stored by this installation — written in the
 * Pine editor or imported as `.pine` files. User-owned.
 *
 * Community, Marketplace, Purchased, Fundamentals and Trending remain absent,
 * because they would be promises about a library that does not exist.
 *
 * ── TVP8 R3: why this stopped being a filter console ───────────────────────
 *
 * The dialog had TWO navigation systems for one list — a sidebar of six
 * counted entries and a wrapping row of seven counted chips, with every entry
 * in the second repeating one in the first — plus two-line rows carrying a
 * green BUILT-IN badge, a description, a `Star` text button and a bordered
 * `Add` button, plus a template EDITOR and a `.pine` import block below the
 * list, inside the same scroll. A context-clean reviewer named the product in
 * under a second from that shape alone.
 *
 * The reference's dialog is: search, a library rail with two headings, a tab
 * row, and a one-line list you click. So:
 *
 *   - Favourites are the row's star, and a FAVORITES group when one exists.
 *   - Recents are a RECENTS group when one exists. Neither is a rail entry,
 *     and neither carries a count — a count beside a filter is the filter
 *     answering a question nobody asked.
 *   - "On this chart" is not in the browser at all. The pane legends and
 *     `IndicatorsPanel` already show what is applied; here it survives only as
 *     the last line of a row's `?` tooltip.
 *   - Descriptions and categories are that same `?` tooltip.
 *   - Indicator TEMPLATES are a toolbar control of their own
 *     (`components/tv/IndicatorTemplatesMenu`), which is where the reference
 *     has them and where they stop being a second feature in a shared dialog.
 *   - Importing a `.pine` file is an `Import…` row at the top of My scripts,
 *     not a footer under every library.
 *
 * ── Which chart it adds to ─────────────────────────────────────────────────
 *
 * The focused pane's study list, handed in as `indicators`. The page resolves
 * that from `workspace.activePaneId`, so this component cannot add to the
 * wrong chart. The reference does not caption the dialog with which chart it
 * will land on and neither does this: the focused pane is the toolbar's, and
 * saying so in the dialog was a sentence explaining the product to itself.
 *
 * The side panel (`IndicatorsPanel`) remains what it was: the manager for what
 * is ALREADY on the chart, with each instance's inputs. This dialog is the
 * library; that panel is the chart. They act on the same list.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAsk } from "@/components/AskDialog";
import { type Resolution } from "@/lib/resolution";
import { Modal } from "@/components/Modal";
import { api, type PineScript } from "@/lib/api";
import type { AppliedIndicator } from "@/lib/indicators";
import type { IndicatorsApi } from "@/lib/useIndicators";
import type { NativeStudiesApi } from "@/lib/useNativeStudies";
import {
  CATEGORY_LABELS, loadFavourites, loadRecents, searchStudies, toggleFavourite,
} from "@/lib/native/catalog";
import type { NativeStudyDef } from "@/lib/native/registry";

/** Which library the rail is pointing at. The reference's two, and no more. */
type Library = "technicals" | "scripts";

/** Which tab of that library the pill row is showing. */
type Kind = "indicator" | "strategy";

/*
 * ── The tab row, and why it is two pills rather than seven chips ───────────
 *
 * The reference shows `Indicators · Strategies · Profiles · Patterns`, in one
 * 28px row, with no counts. Two of those four are not true here: this build
 * files its volume-profile studies under Indicators like every other overlay,
 * and it has no browsable pattern library at all — `Profiles` and `Patterns`
 * would be tabs onto nothing, which is the same empty promise a `Community`
 * heading would be. The two that ARE true are the two the Pine compiler
 * already reports for every script and the two the native registry is filed
 * under.
 */
const KINDS: { id: Kind; label: string }[] = [
  { id: "indicator", label: "Indicators" },
  { id: "strategy", label: "Strategies" },
];

/** How many recently-used studies are worth a group. The reference shows few. */
const RECENTS_SHOWN = 5;

export interface IndicatorBrowserProps {
  open: boolean;
  onClose: () => void;
  /** The chart this dialog adds to — the focused pane. */
  symbol: string;
  interval: Resolution;
  /** The focused pane's Pine studies, or null while that pane is still mounting. */
  indicators: IndicatorsApi | null;
  /** The focused pane's built-in studies, or null while it is still mounting. */
  nativeStudies: NativeStudiesApi | null;
  /** Load a saved script into the Pine Editor tab for editing. */
  onOpenInEditor: (script: PineScript) => void;
}

/** One 28px tab. Selected is a NEUTRAL filled pill — accent is never selection. */
const PILL = "flex h-7 items-center rounded-md px-2.5 text-[13px] transition-colors";

export function IndicatorBrowser(props: IndicatorBrowserProps) {
  const { open, onClose, indicators } = props;
  const ask = useAsk();
  const [library, setLibrary] = useState<Library>("technicals");
  const [kind, setKind] = useState<Kind>("indicator");
  const [scripts, setScripts] = useState<PineScript[]>([]);
  const [favourites, setFavourites] = useState<string[]>([]);
  const [recents, setRecents] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const applied: AppliedIndicator[] = useMemo(() => indicators?.list ?? [], [indicators]);
  const searching = q.trim().length > 0;

  const refresh = useCallback(async () => {
    try {
      setScripts(await api.listPineScripts());
      setLibraryError(null);
    } catch (e) {
      // The library is the whole point of this dialog, so its absence is said
      // rather than rendered as "no scripts yet" — which would read as an
      // empty library and invite the user to import what they already have.
      setLibraryError((e as Error).message);
    }
  }, []);

  // Fresh every open: a script saved in the editor since last time should be
  // here, and a stale filter from a previous visit should not.
  useEffect(() => {
    if (!open) return;
    setQ("");
    setFavourites(loadFavourites());
    setRecents(loadRecents());
    setLibrary("technicals");
    setKind("indicator");
    void refresh();
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open, refresh]);

  /** How many instances of this script are on the chart right now. */
  const appliedCount = useCallback((script: PineScript): number =>
    applied.filter((i) => i.scriptId === script.id).length, [applied]);

  /** How many instances of this built-in are on the focused chart. */
  const nativeCount = useCallback((id: string): number =>
    (props.nativeStudies?.list ?? []).filter((s) => s.defId === id).length,
    [props.nativeStudies]);

  /**
   * Every built-in this view is showing, in the reference's order.
   *
   * `searchStudies` ranks while there is a query and returns the registry
   * untouched when there is not; alphabetical is what the reference's resting
   * list is, so the resting list is sorted here rather than in the registry,
   * which other callers read in its own order.
   */
  const nativeList = useMemo<NativeStudyDef[]>(() => {
    const matched = searchStudies(q);
    /*
     * The native catalogue is a catalogue of INDICATORS. There is no built-in
     * strategy in this build, so the Strategies tab over Technicals is honestly
     * empty rather than quietly showing the indicators again.
     */
    const kinded = searching || kind === "indicator" ? matched : [];
    return searching ? kinded : [...kinded].sort((a, b) => a.name.localeCompare(b.name));
  }, [q, searching, kind]);

  /** Every Pine script this view is showing. */
  const scriptList = useMemo<PineScript[]>(() => {
    const needle = q.trim().toLowerCase();
    const matches = (s: PineScript): boolean =>
      needle.length === 0 || s.name.toLowerCase().includes(needle);
    const kinded = searching ? scripts : scripts.filter((s) => s.kind === kind);
    return kinded.filter(matches).sort((a, b) => a.name.localeCompare(b.name));
  }, [scripts, q, searching, kind]);

  /** The built-ins a FAVORITES group would hold, in the list's own order. */
  const favouriteList = useMemo<NativeStudyDef[]>(() => {
    const wanted = new Set(favourites);
    return nativeList.filter((d) => wanted.has(d.id));
  }, [nativeList, favourites]);

  /** The built-ins a RECENTS group would hold, most recent first. */
  const recentList = useMemo<NativeStudyDef[]>(() => {
    const order = new Map(recents.map((id, i) => [id, i]));
    return nativeList.filter((d) => order.has(d.id))
      .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
      .slice(0, RECENTS_SHOWN);
  }, [nativeList, recents]);

  const addNative = useCallback((def: NativeStudyDef): void => {
    if (!props.nativeStudies) return;
    props.nativeStudies.add(def.id);
    setRecents(loadRecents());
    // The dialog stays open, the way the reference's does: adding three
    // studies is three clicks, not three round trips through the toolbar.
  }, [props.nativeStudies]);

  const addScript = useCallback(async (s: PineScript): Promise<void> => {
    if (!indicators) return;
    setBusy(true);
    try {
      // The list endpoint returns source too, but re-fetch so a script edited
      // in another tab is applied as it stands now.
      const full = await api.getPineScript(s.id);
      indicators.add({ scriptId: full.id, name: full.name, source: full.source });
    } catch (e) {
      setLibraryError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [indicators]);

  const removeScript = async (s: PineScript): Promise<void> => {
    if (!await ask.confirm({
      title: `Delete “${s.name}” from the library?`,
      body: "Studies already on a chart stay where they are.",
      confirmLabel: "Delete", tone: "danger",
    })) return;
    try {
      await api.deletePineScript(s.id);
      await refresh();
    } catch (e) {
      setLibraryError((e as Error).message);
    }
  };

  /** Import one or more .pine files straight into the library. */
  const onFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    setBusy(true);
    const failed: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const source = await file.text();
        const name = file.name.replace(/\.(pine|txt)$/i, "");
        await api.savePineScript(name, source);
      } catch (e) {
        failed.push(`${file.name}: ${(e as Error).message}`);
      }
    }
    await refresh();
    setBusy(false);
    if (failed.length > 0) setLibraryError(failed.join(" · "));
    if (fileRef.current) fileRef.current.value = "";
  };

  /**
   * Enter adds the first result.
   *
   * Search is focused when the browser opens, and the rows are a listbox — so
   * reaching the third result costs three Down-arrows. Typing a name and
   * pressing Enter is what a user reaching for a known study actually does,
   * and it is the whole distance from the search box to the chart. It is
   * BEHAVIOUR: the reference does not print a sentence under the field telling
   * you about it, and neither does this.
   */
  const addFirstResult = useCallback((): void => {
    const first = nativeList[0];
    if (first && props.nativeStudies) { addNative(first); return; }
    const script = scriptList[0];
    if (script) void addScript(script);
  }, [nativeList, scriptList, props.nativeStudies, addNative, addScript]);

  /** The `?` tooltip: what the row's second line used to say, on demand. */
  const nativeInfo = useCallback((def: NativeStudyDef): string => {
    const count = nativeCount(def.id);
    return `${CATEGORY_LABELS[def.category]} · ${def.description}`
      + (count > 0 ? `\nOn this chart · ${count} instance${count === 1 ? "" : "s"}` : "");
  }, [nativeCount]);

  const scriptInfo = useCallback((s: PineScript): string => {
    const count = appliedCount(s);
    return `${s.kind === "strategy" ? "Strategy" : "Indicator"} · saved `
      + `${s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : "locally"}`
      + (count > 0 ? `\nOn this chart · ${count} instance${count === 1 ? "" : "s"}` : "");
  }, [appliedCount]);

  const nativeRow = (def: NativeStudyDef): React.ReactNode => (
    <BrowserRow
      key={def.id}
      name={def.name}
      query={q}
      info={nativeInfo(def)}
      starred={favourites.includes(def.id)}
      onToggleStar={() => setFavourites(toggleFavourite(def.id))}
      onAdd={() => addNative(def)}
      disabled={!props.nativeStudies}
    />
  );

  const scriptRow = (s: PineScript): React.ReactNode => (
    <BrowserRow
      key={s.id}
      name={s.name}
      query={q}
      info={scriptInfo(s)}
      onAdd={() => void addScript(s)}
      disabled={busy || !indicators}
      trailing={
        <>
          <RowGlyph
            label={`Edit ${s.name} in the Pine Editor`}
            onClick={() => void api.getPineScript(s.id).then(props.onOpenInEditor).then(onClose)}
          >
            <path d="M4 16.5V20h3.5L18 9.5 14.5 6 4 16.5zM13.3 7.2l3.5 3.5" />
          </RowGlyph>
          <RowGlyph label={`Delete ${s.name} from the library`} danger
            onClick={() => void removeScript(s)}>
            <path d="M4 6.5h16M9.5 6.5V4h5v2.5M6.5 6.5l1 13.5h9l1-13.5" />
          </RowGlyph>
        </>
      }
    />
  );

  return (
    <Modal open={open} onClose={onClose}
      wide
      title="Indicators, metrics, and strategies"
      /* 840×638 and a 62px header, measured off the reference. */
      panelClassName="!max-w-[840px] !h-[638px] !max-h-[calc(100vh-24px)]"
      headerClassName="!py-[15px]"
      /*
        R3-07: the LIST scrolls, and nothing else.

        `Modal` wraps its children in one `overflow-y-auto`, so the library
        rail, the tab row and — while it existed — the template editor scrolled
        away together with the rows. In the reference the rail and the tabs are
        fixed and a thin scrollbar sits at the list's own right edge.
      */
      scrollBody={false}
      contentClassName="!px-5 !pt-0 !pb-0"
    >
      {/* ── search ── */}
      <div className="relative shrink-0 pt-[9px]">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"
          className="pointer-events-none absolute left-3 top-[calc(50%+4px)] -translate-y-1/2 text-ink-faint">
          <circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" />
        </svg>
        <input
          ref={searchRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !searching) return;
            e.preventDefault();
            addFirstResult();
          }}
          /*
            `Search`. It read "Search this installation's scripts and
            templates…" — 47 characters explaining the dialog from inside its
            own field — and carried `focus:border-accent`, which painted an
            accent ring the instant the dialog opened because the field is
            focused programmatically. The product's one `:focus-visible` rule
            is the focus indicator here, as everywhere.
          */
          placeholder="Search"
          aria-label="Search indicators"
          className="h-[34px] w-full rounded-md border border-control-border bg-transparent
            pl-9 pr-9 text-sm text-ink outline-none placeholder:text-ink-faint"
        />
        {searching && (
          <button
            type="button"
            onClick={() => { setQ(""); searchRef.current?.focus(); }}
            aria-label="Clear the search"
            title="Clear the search"
            className="absolute right-2 top-[calc(50%+4px)] flex h-6 w-6 -translate-y-1/2
              items-center justify-center rounded text-ink-faint hover:text-ink"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" />
            </svg>
          </button>
        )}
      </div>

      <div className="mt-3 flex min-h-0 flex-1 gap-4">
        {/*
          ── the library rail ────────────────────────────────────────────────

          Two sections, and every entry in them is a library this installation
          really has. It held six entries with counts, four of which were
          filters rather than libraries (`On this chart`, `Favourites`,
          `Recents`, `Indicator templates`) — and the selected one was filled
          with `bg-surface-2`, which is the dialog's OWN background colour, so
          selection was invisible except by weight.
        */}
        <nav aria-label="Indicator library"
          className="hidden w-[200px] shrink-0 flex-col overflow-hidden sm:flex">
          <LibrarySection title="Personal" />
          <LibraryNavButton
            active={!searching && library === "scripts"}
            onClick={() => { setLibrary("scripts"); setKind("indicator"); }}
            label="My scripts"
          >
            <circle cx="12" cy="8" r="3.4" /><path d="M5 20c0-3.6 3.1-5.6 7-5.6s7 2 7 5.6" />
          </LibraryNavButton>
          <LibrarySection title="Built-in" />
          <LibraryNavButton
            active={!searching && library === "technicals"}
            onClick={() => { setLibrary("technicals"); setKind("indicator"); }}
            label="Technicals"
          >
            <path d="M4 19V6M4 19h15" />
            <path d="M7.5 16l3.5-5 3 3 4.5-7" />
          </LibraryNavButton>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          {/*
            The tab row, and the column header under it. Both are absent while
            a query is running: search spans both libraries and groups its own
            results, so a tab that filters one of them would be describing a
            list it is not in charge of.
          */}
          {!searching && (
            <div role="tablist" aria-label="Script kind" className="flex shrink-0 items-center gap-1.5">
              {KINDS.map((k) => (
                <button
                  key={k.id}
                  role="tab"
                  aria-selected={kind === k.id}
                  onClick={() => setKind(k.id)}
                  className={`${PILL} ${
                    // accent is never selection — the contract's own rule.
                    kind === k.id
                      ? "bg-surface-3 font-medium text-ink"
                      : "text-ink-muted hover:bg-state-hover hover:text-ink"
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </div>
          )}

          {libraryError && (
            <p role="alert" className="mt-2 shrink-0 rounded border border-down/30 bg-down/10 px-3 py-2 text-[12px] text-down">
              The script library could not be read: {libraryError}. Nothing on the chart changed.
            </p>
          )}

          <div
            aria-label="Indicators"
            className="min-h-0 flex-1 overflow-y-auto pb-4"
          >
            {searching ? (
              <>
                {/*
                  ── R3-05: results are grouped by library, and the match is lit ─

                  A flat five-row list under a chip row said nothing about WHERE
                  a result came from, and nothing about why it matched — an
                  alias hit ("BB" → Bollinger Bands) looked like a mistake.
                  accent-is-meaning: the accent here is DATA — which characters
                  of this name the query matched — not a decoration and not a
                  selection.
                */}
                {nativeList.length > 0 && <GroupHeader>Technicals</GroupHeader>}
                {nativeList.map(nativeRow)}
                {scriptList.length > 0 && <GroupHeader>My scripts</GroupHeader>}
                {scriptList.map(scriptRow)}
                {nativeList.length === 0 && scriptList.length === 0 && (
                  <p className="py-6 text-center text-[12px] text-ink-faint">
                    Nothing in either library matches that search.
                  </p>
                )}
              </>
            ) : library === "technicals" ? (
              <>
                {/*
                  Favourites and recents are GROUPS of this list, the way the
                  reference has them — present when they hold something, gone
                  when they do not, and never a rail entry with a `0` beside it.
                */}
                {favouriteList.length > 0 && (
                  <>
                    <GroupHeader>Favorites</GroupHeader>
                    {favouriteList.map(nativeRow)}
                  </>
                )}
                {recentList.length > 0 && (
                  <>
                    <GroupHeader>Recents</GroupHeader>
                    {recentList.map(nativeRow)}
                  </>
                )}
                <GroupHeader>Script name</GroupHeader>
                {nativeList.map(nativeRow)}
                {nativeList.length === 0 && (
                  <p className="py-6 text-center text-[12px] text-ink-faint">
                    This build ships no built-in strategies. Strategies you write
                    in the Pine Editor appear under My scripts.
                  </p>
                )}
              </>
            ) : (
              <>
                <GroupHeader>Script name</GroupHeader>
                {/*
                  Import, as a row of the library it imports INTO. It was a
                  button in a footer under every library, beside a sentence
                  naming the focused chart — two things the reference's dialog
                  does not have, in the place its list reaches the bottom edge.
                */}
                <ImportRow disabled={busy} onClick={() => fileRef.current?.click()} />
                {scriptList.map(scriptRow)}
                {scriptList.length === 0 && !libraryError && (
                  <p className="py-6 text-center text-[12px] text-ink-faint">
                    {scripts.length === 0
                      ? "No scripts saved yet. Import a .pine file, or write one in the Pine Editor."
                      : kind === "strategy"
                        ? "No strategy saved yet."
                        : "No script matches that search."}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".pine,.txt"
        multiple
        hidden
        onChange={(e) => void onFiles(e.target.files)}
      />
    </Modal>
  );
}

/** An 11px/400 uppercase section label in a 30px row — the reference's rail. */
function LibrarySection({ title }: { title: string }) {
  return (
    <h3 className="flex h-[30px] shrink-0 items-center px-2 text-[11px] uppercase tracking-wide text-ink-faint">
      {title}
    </h3>
  );
}

/**
 * One library, at the reference's 40px pitch with a 20px line glyph.
 *
 * The selected fill is `surface-3`, not `surface-2`: `surface-2` IS the
 * dialog's own background, so the selected row used to be invisible except by
 * its weight. Neutral, never accent — selection is a neutral chip everywhere
 * in this product.
 */
function LibraryNavButton({
  active, onClick, label, children,
}: { active: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex h-10 w-full shrink-0 items-center gap-3 rounded px-2 text-left text-[14px] ${
        active ? "bg-surface-3 font-semibold text-ink" : "text-ink-muted hover:bg-state-hover hover:text-ink"
      }`}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
        aria-hidden="true" className="shrink-0">
        {children}
      </svg>
      <span className="truncate">{label}</span>
    </button>
  );
}

/** An 11px muted group heading — `SCRIPT NAME`, `TECHNICALS`, `FAVORITES`. */
function GroupHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[26px] items-end px-2 pb-1 text-[11px] uppercase tracking-wide text-ink-faint">
      {children}
    </div>
  );
}

/**
 * The matched characters, in accent.
 *
 * accent-is-meaning: this is data about the row — which part of the name the
 * query found — not a highlight for emphasis and not a selection.
 */
function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLowerCase();
  const at = needle.length === 0 ? -1 : text.toLowerCase().indexOf(needle);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="text-accent">{text.slice(at, at + needle.length)}</span>
      {text.slice(at + needle.length)}
    </>
  );
}

/**
 * One script in the list.
 *
 * ── Why the ROW is the control ─────────────────────────────────────────────
 *
 * Each row used to be a `div` holding a green `BUILT-IN` badge, a 13px name, an
 * 11px description, a `Star` text button and a bordered `Add` button — 36px of
 * pitch for one line of information, and the add action was the button rather
 * than the row. The reference's row is 32px, one 14px name, and clicking
 * anywhere on it adds the script; the star and the info glyph appear on hover,
 * at the two edges.
 *
 * ── Why the edge affordances are siblings, not children ────────────────────
 *
 * A button inside a button is not valid HTML: the inner one is unreachable by
 * keyboard and the outer one's accessible name absorbs it. So the row's own
 * button fills the row in normal flow and the star and the glyphs are
 * absolutely positioned over its two ends, with the row's padding reserving
 * the space they occupy. Every one of them is a real, separately focusable
 * control, and the row is still one click anywhere.
 */
function BrowserRow({
  name, query, info, starred, onToggleStar, onAdd, disabled = false, trailing,
}: {
  name: string;
  query: string;
  info: string;
  starred?: boolean;
  onToggleStar?: () => void;
  onAdd: () => void;
  disabled?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <div className={`group/row relative flex h-8 items-center rounded ${
      disabled ? "opacity-50" : "hover:bg-state-hover"
    }`}>
      <button
        type="button"
        onClick={onAdd}
        disabled={disabled}
        title={info}
        className="flex h-8 w-full items-center truncate rounded pl-7 pr-20 text-left
          text-[14px] text-ink disabled:cursor-not-allowed"
      >
        <span className="min-w-0 truncate">
          <Highlight text={name} query={query} />
        </span>
      </button>
      {onToggleStar && (
        <span className="absolute left-0 top-0 flex h-8 w-7 items-center justify-center">
          <button
            type="button"
            onClick={onToggleStar}
            aria-pressed={starred}
            aria-label={starred ? `Unfavourite ${name}` : `Favourite ${name}`}
            title={starred ? "Remove from favourites" : "Add to favourites"}
            className={`flex h-6 w-6 items-center justify-center rounded transition-opacity ${
              starred
                ? "text-warn opacity-100"
                : "text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover/row:opacity-100"
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.6"
              strokeLinejoin="round" fill={starred ? "currentColor" : "none"} aria-hidden="true">
              <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z" />
            </svg>
          </button>
        </span>
      )}
      <span className="absolute right-1 top-0 flex h-8 items-center">
        {trailing}
        {/*
          The `?`, and what it carries: the category, the description and — when
          the study is applied — how many instances of it this chart holds.
          Those were the row's permanent second line, an 11px sentence under
          every one of 57 names. On hover, at the right edge, is where the
          reference keeps the same information.
        */}
        <RowGlyph label={`About ${name}`} title={info}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.6 9.3a2.5 2.5 0 1 1 3.2 2.4c-.5.2-.8.7-.8 1.2v.6" />
          <path d="M12 16.6h.01" />
        </RowGlyph>
      </span>
    </div>
  );
}

/** One hover-revealed 24×24 affordance at a row's right edge. */
function RowGlyph({
  label, title, danger = false, onClick, children,
}: {
  label: string;
  title?: string;
  danger?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      className={`ml-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-0
        transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100 ${
        danger ? "text-ink-faint hover:text-down" : "text-ink-faint hover:text-ink"
      }`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

/** `Import…`, at the head of the library it imports into. */
function ImportRow({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title="Import .pine files from disk"
      className="flex h-8 w-full items-center rounded pr-1 text-left hover:bg-state-hover
        disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="flex w-7 shrink-0 items-center justify-center text-ink-faint">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 15.5V4M8 8l4-4 4 4" /><path d="M4 15v4h16v-4" />
        </svg>
      </span>
      <span className="min-w-0 flex-1 truncate text-[14px] text-ink-muted">Import…</span>
    </button>
  );
}
