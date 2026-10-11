"use client";
/**
 * The rows of a drawing's `Template` menu, and the one way a template is saved.
 *
 * ── W2A-03: one menu, three doors ──────────────────────────────────────────
 *
 * The reference reaches a drawing's templates from the floating toolbar
 * (`Save Drawing Template As…`, `Apply Default Drawing Template`, then the
 * saved ones), from the drawing menu's `Template ›` and from the settings
 * dialog's footer. This product's toolbar had a `Template ⌄` that opened the
 * whole settings dialog — a control named for one thing that did another —
 * and the dialog's footer had a menu with no way back to the default.
 *
 * The rows live here so the toolbar and the dialog cannot drift: the same
 * order, the same per-tool list (`templatesForTool`), the same delete. The
 * context menu, which is a payload rather than markup, builds the same three
 * groups in `lib/menuPayloads`.
 */
import type { ReactNode, RefObject } from "react";
import { useAsk } from "@/components/AskDialog";
import { menuItems, moveMenuFocus } from "@/lib/menuKeyboard";
import {
  deleteDrawingTemplate, loadDrawingTemplates, saveDrawingTemplate, templatesForTool,
  type Drawing, type DrawingTemplate,
} from "@/lib/drawings";

type Ask = ReturnType<typeof useAsk>;

/**
 * Ask for a name and save `drawing`'s style under it, for its tool.
 *
 * Reads storage afresh rather than trusting a caller's copy: the toolbar, the
 * dialog and the context menu each hold the list only while they are open,
 * and a template saved through one must not be lost to a stale list in another.
 * A name the tool already has is replaced only once the user has said so.
 */
export async function saveDrawingTemplateAs(ask: Ask, drawing: Drawing): Promise<DrawingTemplate[] | null> {
  const name = (await ask.promptFor({
    title: "Save drawing template as",
    label: "Template name",
    placeholder: "Thin dashed",
    confirmLabel: "Save",
  }))?.trim();
  if (!name) return null;
  const all = loadDrawingTemplates();
  const clash = all.some((t) => t.name === name && t.tool === drawing.tool);
  if (clash && !await ask.confirm({
    title: `Replace the template “${name}”?`,
    body: "A template with this name already exists for this tool.",
    confirmLabel: "Replace",
  })) return null;
  return saveDrawingTemplate(all, name, drawing.style, drawing.tool);
}

/** Delete `template` once the user has confirmed it; the drawings using it keep their style. */
export async function deleteDrawingTemplateAsk(ask: Ask, template: DrawingTemplate): Promise<DrawingTemplate[] | null> {
  if (!await ask.confirm({
    title: `Delete the template “${template.name}”?`,
    body: "Drawings already using this style keep it.",
    confirmLabel: "Delete", tone: "danger",
  })) return null;
  return deleteDrawingTemplate(loadDrawingTemplates(), template);
}

const ROW ="tvc-menu-row px-3 text-left text-sm text-ink";

/**
 * The menu: save, apply default, then this tool's saved templates.
 *
 * The `role="menu"` container is drawn here with its rows, not by the caller,
 * so the menu and its row grammar are one component (`tests/uiContract`: a
 * file that opens a `.tvc-menu` draws `.tvc-menu-row`s in it). The caller says
 * only where it sits.
 */
export function DrawingTemplateMenuPanel({
  className, menuRef, ...rows
}: Parameters<typeof DrawingTemplateRows>[0] & {
  className: string;
  menuRef?: RefObject<HTMLDivElement>;
}): ReactNode {
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Drawing template"
      onKeyDown={(e) => {
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          moveMenuFocus(menuItems(e.currentTarget), document.activeElement, e.key);
        }
      }}
      className={`tvc-menu--compact ${className}`}
    >
      <DrawingTemplateRows {...rows} />
    </div>
  );
}

/** The menu's rows: save, apply default, then this tool's saved templates. */
function DrawingTemplateRows({
  tool, templates, onSaveAs, onApplyDefault, onApply, onDelete, long = false, disabled = false,
}: {
  tool: Drawing["tool"];
  templates: readonly DrawingTemplate[];
  onSaveAs: () => void;
  onApplyDefault: () => void;
  onApply: (template: DrawingTemplate) => void;
  onDelete: (template: DrawingTemplate) => void;
  /**
   * The toolbar's wording (`Save Drawing Template As…`) rather than the
   * dialog's and the context menu's (`Save as…`) — the reference uses both,
   * each where there is room for it.
   */
  long?: boolean;
  /** A locked drawing can be saved FROM but not restyled. */
  disabled?: boolean;
}): ReactNode {
  const offered = templatesForTool(templates, tool);
  return (
    <>
      <button type="button" role="menuitem" className={ROW} onClick={onSaveAs}>
        {long ? "Save Drawing Template As…" : "Save as…"}
      </button>
      <button
        type="button" role="menuitem" className={`${ROW} disabled:opacity-40`}
        disabled={disabled}
        title={disabled ? "This drawing is locked" : undefined}
        onClick={onApplyDefault}
      >
        {long ? "Apply Default Drawing Template" : "Apply default"}
      </button>
      {offered.length > 0 && <div className="tvc-menu-sep" />}
      {offered.map((t) => (
        <div key={`${t.tool ?? "*"}:${t.name}`} className={`${ROW} justify-between gap-2`}>
          <button
            type="button" role="menuitem" disabled={disabled}
            className="min-w-0 flex-1 truncate text-left disabled:opacity-40"
            onClick={() => onApply(t)}
          >
            {t.name}
          </button>
          <button
            type="button" aria-label={`Delete ${t.name}`}
            className="tvc-control flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink"
            onClick={() => onDelete(t)}
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor"
              strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
              <path d="M2.5 3.5h9M5.5 3.5V2h3v1.5M3.8 3.5l.6 8h5.2l.6-8M6 6v4M8 6v4" />
            </svg>
          </button>
        </div>
      ))}
    </>
  );
}
