"use client";

import { useState, type ReactNode } from "react";

export interface ObjectStudyRow {
  id: string;
  label: string;
  visible: boolean;
  onToggleVisible: () => void;
  onRemove: () => void;
}

export interface ObjectDrawingRow extends ObjectStudyRow {
  locked: boolean;
  onToggleLock: () => void;
}

export interface DataWindowModel {
  time: string;
  ohlc: readonly { label: "Open" | "High" | "Low" | "Close"; value: string }[];
  plots: readonly { id: string; label: string; value: string }[];
}

export interface ObjectsDataPanelProps {
  seriesLabel: string;
  studies: readonly ObjectStudyRow[];
  drawings: readonly ObjectDrawingRow[];
  data: DataWindowModel;
}

function Eye({ open }: { open: boolean }): ReactNode {
  return open ? (
    <><path d="M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Z" /><circle cx="12" cy="12" r="2.2" /></>
  ) : (
    <><path d="M4 4l16 16M9.5 7.4A9.7 9.7 0 0 1 12 7c5.8 0 9 5 9 5a14 14 0 0 1-2.1 2.6M14.7 16.6A9.6 9.6 0 0 1 12 17c-5.8 0-9-5-9-5a14 14 0 0 1 2.2-2.7" /></>
  );
}

function Action({ label, pressed, onClick, children }: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={pressed}
      onClick={onClick}
      className="tvc-control flex h-7 w-7 shrink-0 items-center justify-center text-ink-muted hover:text-ink">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

export function ObjectsDataPanel({ seriesLabel, studies, drawings, data }: ObjectsDataPanelProps) {
  const [tab, setTab] = useState<"objects" | "data">("objects");
  return (
    <aside data-objects-data-panel className="flex h-full w-[85vw] max-w-[300px] shrink-0 flex-col bg-surface md:w-[300px]">
      <div className="flex h-[46px] shrink-0 items-end border-b border-border px-2" role="tablist" aria-label="Objects and data window">
        {(["objects", "data"] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`relative h-[40px] px-3 text-[14px] ${tab === id ? "font-semibold text-ink" : "text-ink-muted"}`}>
            {id === "objects" ? "Objects" : "Data window"}
            {tab === id && <span aria-hidden="true" className="absolute inset-x-2 bottom-0 h-0.5 bg-ink-muted" />}
          </button>
        ))}
      </div>

      {tab === "objects" ? (
        <div role="tabpanel" aria-label="Objects" className="min-h-0 flex-1 overflow-y-auto py-1">
          <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-faint">Main series</p>
          <div data-object-series className="flex h-11 items-center gap-2 px-3 text-[13px] text-ink sm:h-8">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
              <path d="M3 17l5-6 4 3 4-6 5 4" />
            </svg>
            <span className="min-w-0 flex-1 truncate">{seriesLabel}</span>
          </div>

          {studies.length > 0 && <>
            <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-faint">Studies</p>
            {studies.map((study) => (
              <div key={study.id} data-object-study={study.id} className="flex h-11 items-center pl-3 pr-1 text-[13px] sm:h-8">
                <span className="min-w-0 flex-1 truncate text-ink">{study.label}</span>
                <Action label={`${study.visible ? "Hide" : "Show"} ${study.label}`} pressed={!study.visible} onClick={study.onToggleVisible}>
                  <Eye open={study.visible} />
                </Action>
                <Action label={`Remove ${study.label}`} onClick={study.onRemove}>
                  <path d="M5 7h14M9 7V4h6v3M8 10v8M12 10v8M16 10v8M7 7l1 14h8l1-14" />
                </Action>
              </div>
            ))}
          </>}

          {drawings.length > 0 && <>
            <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-faint">Drawings</p>
            {drawings.map((drawing) => (
              <div key={drawing.id} data-object-drawing={drawing.id} className="flex h-11 items-center pl-3 pr-1 text-[13px] sm:h-8">
                <span className="min-w-0 flex-1 truncate text-ink">{drawing.label}</span>
                <Action label={`${drawing.visible ? "Hide" : "Show"} ${drawing.label}`} pressed={!drawing.visible} onClick={drawing.onToggleVisible}>
                  <Eye open={drawing.visible} />
                </Action>
                <Action label={`${drawing.locked ? "Unlock" : "Lock"} ${drawing.label}`} pressed={drawing.locked} onClick={drawing.onToggleLock}>
                  {drawing.locked
                    ? <><rect x="6" y="10" width="12" height="10" rx="1.5" /><path d="M8.5 10V7a3.5 3.5 0 0 1 7 0v3" /></>
                    : <><rect x="6" y="10" width="12" height="10" rx="1.5" /><path d="M9 10V7.5a3.5 3.5 0 0 1 6.5-1.8" /></>}
                </Action>
                <Action label={`Remove ${drawing.label}`} onClick={drawing.onRemove}>
                  <path d="M5 7h14M9 7V4h6v3M8 10v8M12 10v8M16 10v8M7 7l1 14h8l1-14" />
                </Action>
              </div>
            ))}
          </>}

          {studies.length === 0 && drawings.length === 0 && (
            <p className="px-3 py-4 text-[12px] text-ink-faint">No studies or drawings on this pane.</p>
          )}
        </div>
      ) : (
        <div role="tabpanel" aria-label="Data window" data-data-window className="min-h-0 flex-1 overflow-y-auto py-2">
          <p className="px-3 pb-2 text-[12px] text-ink-faint">{data.time}</p>
          <dl>
            {data.ohlc.map((row) => (
              <div key={row.label} className="flex h-7 items-center justify-between gap-3 px-3 text-[13px]">
                <dt className="text-ink-muted">{row.label}</dt><dd className="tabular text-ink">{row.value}</dd>
              </div>
            ))}
          </dl>
          {data.plots.length > 0 && <>
            <p className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-faint">Study plots</p>
            <dl>
              {data.plots.map((row) => (
                <div key={row.id} className="flex h-7 items-center justify-between gap-3 px-3 text-[13px]">
                  <dt className="min-w-0 truncate text-ink-muted" title={row.label}>{row.label}</dt>
                  <dd className="shrink-0 tabular text-ink">{row.value}</dd>
                </div>
              ))}
            </dl>
          </>}
        </div>
      )}
    </aside>
  );
}
