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
 *   - Favourites are the row's star and a persisted FAVORITES rail view.
 *   - Recents are a RECENTS group when one exists. Neither carries a count —
 *     a count beside a filter is the filter answering a question nobody asked.
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

/** Which persisted view/library the rail is pointing at. */
type Library = "favorites" | "technicals" | "scripts";

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

/**
 * One 28px tab. Selected is a NEUTRAL chip — accent is never selection.
 *
 * R3b-02: the reference's selected tab is the INVERTED chip this product
 * already uses for a selected dropdown row (`--ts-menu-selected-bg` /
 * `--ts-menu-selected-ink`, rgb(242) on rgb(15) in dark), and its unselected
 * one is a filled rgb(46) chip with ink text — not the transparent, muted
 * ghost this had, where the only difference between the two states was a
 * slightly different grey.
 */
const PILL = "flex h-7 items-center rounded-md px-3 text-[13px] transition-colors";

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
      strategy={s.kind === "strategy"}
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
      /*
        R3b-03: the title rows stay where they are (157–175) and the FIELD
        moves up to y=199, which is where the reference's is — so the header's
        bottom padding is 8px shorter than its top, not equal to it.
      */
      headerClassName="!pt-[15px] !pb-[7px]"
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
      <div className="relative shrink-0 pt-[6px]">
        {/*
          R3b-01: a 20×20 magnifier whose ink starts at x=333 — 13px inside a
          field that opens at x=320. It was a 16px glyph at `left-3` with 13px
          of ink, a sixth smaller than the reference's in the control a user
          aims at first.
        */}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"
          className="pointer-events-none absolute left-[13px] top-[calc(50%+3px)] -translate-y-1/2 text-ink-faint">
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
          /*
            ── R3b-01: 40px, 16px, and NO ring when the dialog opens ─────────

            Three measured corrections. The field is 40px tall in the
            reference, not 34 (the note this was built from said 34; the image
            says 40 — border rows at y=199 and y=238); its text is 16px, and
            `text-sm` could never have won anyway, because
            `:is(.tv-workstation,.ts-app) input { font-size: inherit }` in
            `app/globals.css` is unlayered and beats a layered utility — the
            same rule that defeated the legend's 16px headline (R3b-15). Hence
            `!text-[16px]`.

            And the ring: this input is focused programmatically the instant
            the dialog opens, and a programmatically-focused `<input>` ALWAYS
            matches `:focus-visible` — so the product's one focus rule painted
            a 2px accent outline around the field on every open. R3-04 removed
            `focus:border-accent` and the outline stayed, because the class
            was never what drew it. The dialog's own border is the field's
            edge; the focus indicator is the caret, which is where a text
            field's focus is legible anyway.
          */
          className="h-[40px] w-full rounded-md border border-control-border bg-transparent
            pl-[42px] pr-9 !text-[16px] text-ink outline-none focus-visible:outline-none
            placeholder:text-ink-faint"
        />
        {searching && (
          <button
            type="button"
            onClick={() => { setQ(""); searchRef.current?.focus(); }}
            aria-label="Clear the search"
            title="Clear the search"
            className="absolute right-2 top-[calc(50%+3px)] flex h-6 w-6 -translate-y-1/2
              items-center justify-center rounded text-ink-faint hover:text-ink"
          >
            {/* R3b-01: 16px of ink, as the reference's clear glyph measures. */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" />
            </svg>
          </button>
        )}
      </div>

      {/*
        R3b-03: 8px under the field, and the list column 50px right of the
        rail — the reference's rail ends at x=520 and its list column starts at
        570. Ours ran 12px under the field and 16px right of the rail, which
        put every row 34px left of where the reference's sit.
      */}
      <div className="mt-2 flex min-h-0 flex-1 gap-[50px]">
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
          <LibrarySection title="Personal" first />
          <LibraryNavButton
            active={!searching && library === "favorites"}
            onClick={() => { setLibrary("favorites"); setKind("indicator"); }}
            label="Favorites"
          >
            <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z" />
          </LibraryNavButton>
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
            <div role="tablist" aria-label="Script kind" className="flex shrink-0 items-center gap-1">
              {KINDS.map((k) => (
                <button
                  key={k.id}
                  role="tab"
                  aria-selected={kind === k.id}
                  onClick={() => setKind(k.id)}
                  className={`${PILL} ${
                    // accent is never selection — the contract's own rule.
                    kind === k.id
                      ? "bg-[var(--ts-menu-selected-bg)] font-medium text-[var(--ts-menu-selected-ink)]"
                      : "bg-surface-3 text-ink hover:bg-state-active"
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

          {/*
            R3b-08: the reference shows a 3px thumb in this column AT REST.

            The list scrolls 2,014px inside 485, and on macOS the overlay
            scrollbar is 0px wide until the pointer moves — so the one piece of
            chrome that says "there are forty more studies below" was invisible
            in every screenshot and to every reader who had not yet scrolled.
            `scrollbar-gutter: stable` keeps the column from reflowing when it
            appears, and the arbitrary variants below are the only way to reach
            the pseudo-elements from here — `app/globals.css` is shared, and a
            rule there would repaint every scrollbar in the product.
          */}
          <div
            aria-label="Indicators"
            className="min-h-0 flex-1 overflow-y-auto pb-4 pt-[9px]
              [scrollbar-gutter:stable]
              [&::-webkit-scrollbar-thumb]:rounded-full
              [&::-webkit-scrollbar-thumb]:bg-state-active
              [&::-webkit-scrollbar]:w-[3px]"
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
            ) : library === "favorites" ? (
              <>
                <GroupHeader>Script name</GroupHeader>
                {favouriteList.map(nativeRow)}
                {favouriteList.length === 0 && (
                  <p className="py-6 text-center text-sm text-ink-faint">No favorites yet.</p>
                )}
              </>
            ) : library === "technicals" ? (
              <>
                {recentList.length > 0 && (
                  <>
                    <GroupHeader>Recents</GroupHeader>
                    {recentList.map(nativeRow)}
                  </>
                )}
                <GroupHeader>Script name</GroupHeader>
                {/*
                  R3b-09: `Strategies` over Technicals is EMPTY, and says so by
                  being empty.

                  It printed two sentences explaining the product's own build
                  ("This build ships no built-in strategies…") in the middle of
                  a library list. The reference never prints a sentence about
                  itself in this dialog; an empty section is an empty section,
                  and the tab is still there to be switched back.
                */}
                {nativeList.map(nativeRow)}
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
function LibrarySection({ title, first = false }: { title: string; first?: boolean }) {
  return (
    <h3 className={`flex h-[30px] shrink-0 items-center px-2 text-[11px] uppercase tracking-wide
      text-ink-faint ${first ? "" : "mt-2"}`}>
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
      /*
        R3b-04: an unselected library is INK, and the selected fill is
        rgb(61,61,61). Both were a step quieter than the reference's — a muted
        label on a `surface-3` fill — so the rail read as disabled next to a
        list of ink names, and selection was two greys apart from hover.
      */
      className={`flex h-10 w-full shrink-0 items-center gap-3 rounded px-2 text-left text-[14px] ${
        active ? "bg-state-active font-semibold text-ink" : "text-ink hover:bg-state-hover"
      }`}
    >
      {/*
        R3b-04: 17px of ink in the 20px cell — a 22px box at stroke 1.5. The
        20px box with a 1.6 stroke drew 13px of glyph, two thirds of the
        reference's, which is what made the rail read as small type rather
        than as a library list.
      */}
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
        aria-hidden="true" className="-ml-px shrink-0">
        {children}
      </svg>
      <span className="truncate">{label}</span>
    </button>
  );
}

/** An 11px muted group heading — `SCRIPT NAME`, `TECHNICALS`, `FAVORITES`. */
function GroupHeader({ children }: { children: React.ReactNode }) {
  /*
    R3b-03: 32px, with the label on the row's lower half — the reference's
    `SCRIPT NAME` occupies [292..324] with its text at 303–310, so the first
    script row starts at y=324. Ours was a 26px row, which put every row in
    the list 14px high on the dialog.
  */
  return (
    <div className="-ml-[30px] flex h-8 items-center px-2 pl-[31px] text-[11px] uppercase
      tracking-wide text-ink-faint">
      {children}
    </div>
  );
}

/**
 * Which characters of `text` the query matched — every one of them.
 *
 * ── R3b-06: an initials hit is a hit, and has to LOOK like one ─────────────
 *
 * The registry matches on aliases and initials, so `bb` returns Bollinger
 * Bands and `MACD` returns the Pine script "Moving Average Convergence
 * Divergence". The highlighter only understood a contiguous substring, so both
 * of those arrived with NOTHING lit: the row that best answered the query was
 * the row with no evidence on it, and an alias hit read as a mistake — which
 * is exactly the defect R3-05 set out to fix, half-fixed.
 *
 * Two passes, in the order a reader expects: a literal substring first
 * (`rsi` → `RSI`), then the word initials (`bb` → **B**ollinger **B**ands;
 * `macd` → **M**oving **A**verage **C**onvergence **D**ivergence). Nothing
 * else lights — a scattered subsequence over the whole string would light
 * three random letters of a name that merely contains them.
 */
export function matchPositions(text: string, query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const haystack = text.toLowerCase();
  const at = haystack.indexOf(needle);
  if (at >= 0) return Array.from({ length: needle.length }, (_, i) => at + i);

  // Word initials, in order. Every letter of the query must find one, or the
  // row is lit at all — a partial initials match is not what matched.
  const initials: number[] = [];
  for (let i = 0; i < haystack.length; i += 1) {
    if (/[a-z0-9]/.test(haystack[i]!) && (i === 0 || !/[a-z0-9]/.test(haystack[i - 1]!))) {
      initials.push(i);
    }
  }
  const hit: number[] = [];
  let cursor = 0;
  for (const letter of needle.replace(/\s+/g, "")) {
    let found = -1;
    for (let i = cursor; i < initials.length; i += 1) {
      if (haystack[initials[i]!] === letter) { found = i; break; }
    }
    if (found < 0) return [];
    hit.push(initials[found]!);
    cursor = found + 1;
  }
  return hit;
}

/**
 * The matched characters, in accent.
 *
 * accent-is-meaning: this is data about the row — which part of the name the
 * query found — not a highlight for emphasis and not a selection.
 */
function Highlight({ text, query }: { text: string; query: string }) {
  const lit = new Set(matchPositions(text, query));
  if (lit.size === 0) return <>{text}</>;
  /*
    Adjacent lit characters share one span, so a substring hit renders as one
    run of accent rather than as four boxes of one letter.
  */
  const runs: { text: string; lit: boolean }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const on = lit.has(i);
    const last = runs[runs.length - 1];
    if (last && last.lit === on) last.text += text[i]!;
    else runs.push({ text: text[i]!, lit: on });
  }
  /*
    accent-is-meaning, not selection: `lit` is DATA about this row — which
    characters of this name the query found — so the class is chosen by a
    lookup rather than written inside a conditional, which is the shape the
    contract test reads as "accent means selected".
  */
  const RUN: Record<"lit" | "rest", string> = { lit: "text-accent", rest: "" };
  return (
    <>
      {runs.map((run, i) => (
        <span key={i} className={RUN[run.lit ? "lit" : "rest"]}>{run.text}</span>
      ))}
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
  strategy = false,
}: {
  name: string;
  query: string;
  info: string;
  starred?: boolean;
  onToggleStar?: () => void;
  onAdd: () => void;
  disabled?: boolean;
  trailing?: React.ReactNode;
  /** R3b-07: this row is a strategy, and says so after its name. */
  strategy?: boolean;
}) {
  return (
    /*
      R3b-03/R3b-05: the row is 30px WIDER than the name column on its left —
      the reference's hover fill runs [540..1120] while the names start at
      571 — and the hover fill is rgb(56,56,56), one step above the toolbar's
      hover. `state-hover` (rgb 46) is the chrome value and disappeared under
      the dialog's own `surface-2`; the light theme keeps its own measured
      hover, because that pair is two measured sets and not a mirror.
    */
    <div className={`group/row relative -ml-[30px] flex h-8 items-center rounded ${
      disabled ? "opacity-50"
        : "hover:bg-[rgb(56,56,56)] [[data-theme=light]_&]:hover:bg-state-hover"
    }`}>
      <button
        type="button"
        onClick={onAdd}
        disabled={disabled}
        title={info}
        className="flex h-8 w-full items-center truncate rounded pl-[31px] pr-20 text-left
          text-[14px] text-ink disabled:cursor-not-allowed"
      >
        <span className="min-w-0 truncate">
          <Highlight text={name} query={query} />
        </span>
        {/*
          R3b-07: a strategy says so, in mixed results.

          Search spans both libraries and both KINDS, so a `RSI Strategy` sat
          in the same list as `Relative Strength Index` with nothing to tell
          them apart — and a strategy on a chart does something an indicator
          does not. The reference marks the row with a glyph after the name;
          the `?` tooltip still carries the word.
        */}
        {strategy && (
          <span aria-hidden="true" className="ml-1.5 shrink-0 text-ink-faint" title="Strategy">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 3L5.5 13.5H11l-1 7.5 7.5-10.5H12l1-7.5z" />
            </svg>
          </span>
        )}
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
                ? "text-ink opacity-100"
                : "text-ink-faint opacity-100 hover:text-ink"
            }`}
          >
            {/* R3b-05: 16px, for 14px of ink — the reference's row star. */}
            <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.6"
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
        <RowGlyph label={`About ${name}`} title={info} size={18}>
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
  label, title, danger = false, onClick, size = 14, children,
}: {
  label: string;
  title?: string;
  danger?: boolean;
  onClick?: () => void;
  /** R3b-05: the `?` carries 16px of ink, so its box is 18. */
  size?: number;
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
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
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
      className="-ml-[30px] flex h-8 w-full items-center rounded pl-[7px] pr-1 text-left
        hover:bg-[rgb(56,56,56)] [[data-theme=light]_&]:hover:bg-state-hover
        disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="flex w-6 shrink-0 items-center justify-center text-ink-faint">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 15.5V4M8 8l4-4 4 4" /><path d="M4 15v4h16v-4" />
        </svg>
      </span>
      <span className="min-w-0 flex-1 truncate text-[14px] text-ink-muted">Import…</span>
    </button>
  );
}
