"use client";
/**
 * Indicator templates, as the toolbar control the reference has.
 *
 * ── Why this is a toolbar control and not a block in a dialog ──────────────
 *
 * Template authoring used to live at the bottom of the Indicators browser: an
 * uppercase `SAVE THESE STUDIES AS A TEMPLATE` heading, a sentence explaining
 * what a template is and is not, a name field, a Save button and a status
 * sentence — inside the same scroll region as the 57-row library, where in the
 * opened state it sat 2,000px below the fold. Two features in one dialog, one
 * of them unreachable without scrolling past the other (R3-06).
 *
 * The reference puts a 2×2-grid button on the toolbar immediately after
 * Indicators, opening a menu of `Save indicator template…` and then the saved
 * templates. That is what this is. Nothing about the template FORMAT changed:
 * `lib/indicatorTemplates` is the same module, with the same round-trip and
 * the same refusal to keep a template it cannot prove.
 *
 * ── What it will not do ────────────────────────────────────────────────────
 *
 * It does not APPLY a template itself. Applying means adding studies to the
 * focused pane's two study lists, and those live with the page that resolves
 * `workspace.activePaneId`; a menu that reached into them would be the second
 * place in the product that decides which chart an add lands on. `onApply`
 * hands the template up, and `applyTemplateTo` in `lib/indicatorTemplates` is
 * the one implementation of what applying means.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useAsk } from "@/components/AskDialog";
import { useExclusivePopover } from "@/lib/useExclusivePopover";
import { menuItems, moveMenuFocus } from "@/lib/menuKeyboard";
import {
  TOOL_ICON_BUTTON, TOOL_ICON_SIZE, TOOL_ICON_STROKE,
} from "@/components/tv/toolbarChrome";
import {
  defaultTemplates, deleteTemplate, loadTemplates, saveTemplates, templateFromIndicators,
  upsertTemplate,
  type IndicatorTemplate, type TemplateApplication, type TemplateStudySnapshot,
} from "@/lib/indicatorTemplates";
import type { AppliedIndicator } from "@/lib/indicators";

/**
 * What is on the focused chart right now — the thing a template is made OF.
 *
 * Both halves, because a template that carried only the Pine studies silently
 * dropped all 57 built-ins, and a chart of built-ins alone — which is what
 * most charts are — saved as nothing at all.
 */
export interface TemplateStudies {
  indicators: readonly AppliedIndicator[];
  native: readonly TemplateStudySnapshot[];
}

export interface IndicatorTemplatesMenuProps {
  /** The focused pane's studies, for `Save indicator template…`. */
  studies: TemplateStudies;
  /**
   * Put a saved template's studies on the focused chart, and say what landed.
   *
   * The RETURN type is the point, and it is not decoration: `add` gives nothing
   * back for a study id this build has no definition for — a template written
   * by a newer build, or carried from an installation with a study this one has
   * since dropped — and the loop that applied them used to `continue` and then
   * report "Applied" as though everything had arrived. The only way to notice a
   * quietly missing indicator was to count the legend. `lib/indicatorTemplates`'
   * `applyTemplateTo` produces this record; a handler that cannot produce one
   * has not applied the template.
   */
  onApply: (template: IndicatorTemplate) => TemplateApplication;
}

export function IndicatorTemplatesMenu({ studies, onApply }: IndicatorTemplatesMenuProps) {
  // One popover open at a time across the whole toolbar — see `lib/popoverGroup`.
  const [open, setOpen] = useExclusivePopover("indicator-templates");
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const defaultsRef = useRef<HTMLDivElement>(null);
  const ask = useAsk();
  const [templates, setTemplates] = useState<IndicatorTemplate[]>([]);
  /** R3b-14: whether the shipped sets' submenu is showing. */
  const [defaultsOpen, setDefaultsOpen] = useState(false);

  // Read on every open: another tab may have saved one since the last look.
  useEffect(() => {
    if (!open) { setDefaultsOpen(false); return; }
    setTemplates(loadTemplates());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open, setOpen]);

  useEffect(() => { if (open) menuItems(menuRef.current)[0]?.focus(); }, [open]);

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      moveMenuFocus(menuItems(menuRef.current), document.activeElement, e.key);
    }
  };

  const persist = useCallback((next: IndicatorTemplate[]): void => {
    setTemplates(next);
    saveTemplates(next);
  }, []);

  const onChart = studies.indicators.length + studies.native.length;

  const save = useCallback(async (): Promise<void> => {
    setOpen(false);
    /*
     * The name is asked for through the product's own prompt rather than an
     * inline field in a menu: a menu row that turns into a form is a menu that
     * cannot be dismissed by the same gesture that opened it.
     */
    const name = await ask.promptFor({
      title: `Save ${onChart} stud${onChart === 1 ? "y" : "ies"} as a template`,
      label: "Template name",
      /*
        R3b-13: the placeholder is a placeholder.

        It carried a sentence about what a template is and is not — "Studies
        and their inputs only — not the symbol or the layout" — inside the one
        field whose job is to take a name, which is the same defect the
        Indicators search box had (R3-04). What a template holds is the
        module's contract and this file's own header; a field says what to
        type in it.
      */
      placeholder: "Template name",
      confirmLabel: "Save",
    });
    if (name === null || name.trim().length === 0) return;

    const template = templateFromIndicators(
      name, studies.indicators, new Date(), studies.native);
    const current = loadTemplates();
    let result = upsertTemplate(current, template);
    if (!result.ok && result.reason === "exists") {
      // Overwriting a template the operator built earlier is a decision, not a
      // side effect of reusing a name.
      if (!await ask.confirm({
        title: `A template called “${name.trim()}” already exists`,
        body: "Replacing it overwrites the studies and settings it holds.",
        confirmLabel: "Replace", tone: "danger",
      })) return;
      result = upsertTemplate(current, template, { overwrite: true });
    }
    if (!result.ok) {
      await ask.confirm({
        title: result.reason === "full"
          ? "This browser is holding the maximum number of templates"
          : "There is nothing to save yet",
        body: result.reason === "full"
          ? "Delete one from this menu to make room."
          : "Put at least one study on the chart first.",
        confirmLabel: "Close",
      });
      return;
    }
    persist(result.list);
  }, [ask, onChart, persist, setOpen, studies]);

  /**
   * Apply a template, and say so when part of it could not be applied.
   *
   * Silence here is the failure mode this reports against: a chart that is
   * quietly missing an indicator looks exactly like one that is not.
   */
  const apply = useCallback(async (template: IndicatorTemplate): Promise<void> => {
    const result = onApply(template);
    if (!result || result.missing.length === 0) return;
    await ask.confirm({
      title: `Applied ${result.applied} of ${result.applied + result.missing.length} `
        + `from “${template.name}”`,
      body: `This build has no study called ${result.missing.join(", ")}.`,
      confirmLabel: "Close",
    });
  }, [ask, onApply]);

  const remove = useCallback(async (template: IndicatorTemplate): Promise<void> => {
    if (!await ask.confirm({
      title: `Delete the template “${template.name}”?`,
      body: "Studies on the chart stay where they are.",
      confirmLabel: "Delete", tone: "danger",
    })) return;
    persist(deleteTemplate(loadTemplates(), template.name));
  }, [ask, persist]);

  return (
    <div ref={boxRef} className="relative">
      <button
        ref={buttonRef}
        data-toolbar-control="indicator-templates"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Indicator templates"
        aria-label={templates.length > 0
          ? `Indicator templates — ${templates.length} saved`
          : "Indicator templates"}
        className={TOOL_ICON_BUTTON}
      >
        {/*
          The reference's glyph is a 2×2 grid of squares — four panes of a
          saved arrangement — at the bar's shared 22px / 1.5 stroke, not a
          folder and not a star.
        */}
        <svg width={TOOL_ICON_SIZE} height={TOOL_ICON_SIZE} viewBox="0 0 28 28" fill="none"
          stroke="currentColor" strokeWidth={TOOL_ICON_STROKE}
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {/*
            21.4 square of ink was 38% larger than the reference's 16, which
            made this and the Indicators glyph beside it read as a different
            size family from the rest of the row.
          */}
          <rect x="6" y="6" width="7" height="7" rx="0.9" />
          <rect x="15.1" y="6" width="7" height="7" rx="0.9" />
          <rect x="6" y="15.1" width="7" height="7" rx="0.9" />
          <rect x="15.1" y="15.1" width="7" height="7" rx="0.9" />
        </svg>
      </button>

      {open && (
        <div ref={menuRef} role="menu" aria-label="Indicator templates" onKeyDown={onMenuKeyDown}
          className="absolute left-0 top-[38px] z-50 w-[260px] tvc-menu">
          <button
            role="menuitem"
            onClick={() => void save()}
            disabled={onChart === 0}
            title={onChart === 0
              ? "Put at least one study on the chart first"
              : `Save the ${onChart} stud${onChart === 1 ? "y" : "ies"} on this chart as a template`}
            className="tvc-menu-row w-full px-3 text-left text-[13px] text-ink disabled:opacity-40"
          >
            Save indicator template…
          </button>
          <div role="separator" className="tvc-menu-sep" />
          {/*
            ── R3b-14: the shipped sets ──────────────────────────────────────

            The reference's menu is `Save indicator template…`, then a set of
            DEFAULT templates, then the user's own. Ours had the first and the
            third, and when the third was empty it printed a paragraph
            explaining what to do about it — an apology where the reference has
            a library. Every study in these four sets is a built-in this
            installation computes; see `defaultTemplates`.
          */}
          <div
            className="relative"
            onMouseEnter={() => setDefaultsOpen(true)}
            onMouseLeave={() => setDefaultsOpen(false)}
          >
            <button
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={defaultsOpen}
              onClick={() => setDefaultsOpen((v) => !v)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowRight" && e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                e.stopPropagation();
                setDefaultsOpen(true);
                requestAnimationFrame(() => menuItems(defaultsRef.current)[0]?.focus());
              }}
              className="tvc-menu-row w-full justify-between gap-2 px-3 text-left text-[13px] text-ink"
            >
              Default templates
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor"
                strokeWidth="1.5" aria-hidden="true"><path d="M3.5 2l3 3-3 3" /></svg>
            </button>
            {defaultsOpen && (
              <div ref={defaultsRef} role="menu" aria-label="Default templates"
                className="absolute left-full top-0 z-50 ml-1 w-[220px] tvc-menu">
                {defaultTemplates().map((t) => (
                  <button
                    key={t.name}
                    role="menuitem"
                    onClick={() => { setOpen(false); void apply(t); }}
                    title={`Apply the ${t.name} set — ${t.studies.length} built-in studies`}
                    className="tvc-menu-row w-full px-3 text-left text-[13px] text-ink"
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          {templates.length > 0 && <div role="separator" className="tvc-menu-sep" />}
          {templates.map((t) => (
            /*
              The row applies; the trash appears on hover only, which is the
              grammar every other removable row in this product uses. A delete
              button sitting permanently beside a template a user reaches for
              daily is a mis-click waiting on a 260px menu.
            */
            <div key={t.name} className="tvc-menu-row group/row gap-1 px-3">
              <button
                role="menuitem"
                onClick={() => { setOpen(false); void apply(t); }}
                title={`Apply “${t.name}” — this chart's studies become the `
                  + `${t.indicators.length + t.studies.length} in this template`}
                className="min-w-0 flex-1 truncate text-left text-[13px] text-ink"
              >
                {t.name}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); void remove(t); }}
                aria-label={`Delete the template ${t.name}`}
                title="Delete this template"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint
                  opacity-0 transition-opacity focus-visible:opacity-100 hover:text-down
                  group-hover/row:opacity-100"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 6.5h16M9.5 6.5V4h5v2.5M6.5 6.5l1 13.5h9l1-13.5" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
