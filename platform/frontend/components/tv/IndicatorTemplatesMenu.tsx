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
 * Indicators, opening a menu of `Save indicator template…` and `Open
 * template…` (F-06), the second a dialog holding the saved and the default
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
import { Modal } from "@/components/Modal";
import { MenuGlyphIcon, MenuMark } from "@/components/tv/ContextMenu";
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
  const ask = useAsk();
  const [templates, setTemplates] = useState<IndicatorTemplate[]>([]);
  /** F-06: the `Open template…` library dialog. */
  const [browseOpen, setBrowseOpen] = useState(false);

  // Read on every open: another tab may have saved one since the last look.
  useEffect(() => {
    if (!open && !browseOpen) return;
    setTemplates(loadTemplates());
  }, [open, browseOpen]);

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
        data-tooltip="Indicator templates"
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

      {/*
        ── F-06: two 32px verbs with the shared mark column, 219 wide ────────

        This was two 40px rows with no mark column, 260 wide, the second a
        `Default templates ›` flyout — and the user's own templates listed
        underneath. Premium's menu is `Save indicator template…` and `Open
        template…`, 32px rows, a 28px glyph box, 219 wide; the library itself
        (the defaults and the user's own) is behind `Open template…`.
      */}
      {open && (
        <div ref={menuRef} role="menu" aria-label="Indicator templates" onKeyDown={onMenuKeyDown}
          className="absolute left-0 top-[38px] z-50 w-[219px] tvc-menu tvc-menu--compact">
          <button
            role="menuitem"
            onClick={() => void save()}
            disabled={onChart === 0}
            data-tooltip={onChart === 0
              ? "Put at least one study on the chart first"
              : `Save the ${onChart} stud${onChart === 1 ? "y" : "ies"} on this chart as a template`}
            className="tvc-menu-row w-full gap-1 px-2 text-left text-sm text-ink disabled:opacity-40"
          >
            <MenuMark><MenuGlyphIcon name="save" /></MenuMark>
            <span className="min-w-0 flex-1 truncate">Save indicator template…</span>
          </button>
          <button
            role="menuitem"
            onClick={() => { setOpen(false); setBrowseOpen(true); }}
            data-tooltip={templates.length > 0
              ? `${templates.length} saved, and the default sets`
              : "The default sets, and any you save"}
            className="tvc-menu-row w-full gap-1 px-2 text-left text-sm text-ink"
          >
            <MenuMark><MenuGlyphIcon name="folder" /></MenuMark>
            <span className="min-w-0 flex-1 truncate">Open template…</span>
          </button>
        </div>
      )}

      {/*
        `Open template…`: the user's own templates first, then the shipped
        sets (R3b-14 — every study in them is a built-in this installation
        computes; see `defaultTemplates`). A row applies; the trash on the
        user's own rows deletes, behind the same confirmation as before.
      */}
      <Modal
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        title="Indicator templates"
        panelClassName="!max-w-[520px]"
      >
        <div className="max-h-[420px] overflow-y-auto" data-template-library="">
          <div className="tvc-menu-heading">My templates</div>
          {templates.length === 0 && (
            <p className="px-2 py-3 text-[13px] text-ink-faint">
              None saved yet. Save indicator template… keeps the studies on this chart.
            </p>
          )}
          {templates.map((t) => (
            <div key={t.name} className="group/row flex items-center gap-1 rounded-md px-2 hover:bg-state-hover">
              <button
                onClick={() => { setBrowseOpen(false); void apply(t); }}
                data-template-row={t.name}
                data-tooltip={`Apply “${t.name}” — this chart's studies become the `
                  + `${t.indicators.length + t.studies.length} in this template`}
                className="flex h-10 min-w-0 flex-1 items-center truncate text-left text-sm text-ink"
              >
                {t.name}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); void remove(t); }}
                aria-label={`Delete the template ${t.name}`}
                data-tooltip="Delete this template"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-faint
                  opacity-0 transition-opacity focus-visible:opacity-100 hover:text-ink
                  group-hover/row:opacity-100"
              >
                <MenuGlyphIcon name="trash" />
              </button>
            </div>
          ))}
          <div className="tvc-menu-heading mt-2">Default templates</div>
          {defaultTemplates().map((t) => (
            <button
              key={t.name}
              onClick={() => { setBrowseOpen(false); void apply(t); }}
              data-template-row={t.name}
              data-tooltip={`Apply the ${t.name} set — ${t.studies.length} built-in studies`}
              className="flex h-10 w-full items-center rounded-md px-2 text-left text-sm text-ink hover:bg-state-hover"
            >
              {t.name}
            </button>
          ))}
        </div>
      </Modal>
    </div>
  );
}
