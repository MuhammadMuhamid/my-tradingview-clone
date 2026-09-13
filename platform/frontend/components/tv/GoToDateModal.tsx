"use client";
import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui";
import { CalendarField } from "./CalendarField";

/**
 * "Go to…" — the time axis's date picker.
 *
 * TVP8: right-clicking the time scale used to open Chrome's menu, so there was
 * nowhere for this to live. The reference puts a date picker on exactly that
 * menu, and scrolling a year of 4h bars by dragging to reach last March is the
 * thing it exists to replace.
 *
 * It scrolls; it does not zoom. The span the user is on is kept and moved, so
 * arriving at a date does not also change how much of the chart is on screen.
 *
 * The upper bound is now: a chart cannot go to a bar that has not happened.
 * There is deliberately no lower bound — the pane knows what history it has
 * loaded and this dialog does not, and a date with no bars simply leaves the
 * view where it is rather than being refused by a control that is guessing.
 */
export function GoToDateModal({
  open, onClose, onGo,
}: {
  open: boolean;
  onClose: () => void;
  onGo: (time: number) => void;
}) {
  const [time, setTime] = useState<number | null>(null);

  useEffect(() => { if (open) setTime(Date.now()); }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Go to"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={time === null}
            onClick={() => { if (time !== null) onGo(time); }}>
            Go
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <span className="text-xs text-ink-muted">
          The chart scrolls to this moment and keeps the span you are on.
        </span>
        <CalendarField
          id="go-to-date"
          label="Date and time to go to"
          value={time}
          onChange={setTime}
          max={Date.now()}
        />
      </div>
    </Modal>
  );
}
