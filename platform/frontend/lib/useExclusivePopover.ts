"use client";
/**
 * `useState`-shaped, but only one of them can be true at a time.
 *
 * Deliberately the same shape as the `const [open, setOpen] = useState(false)`
 * it replaces, so adopting it in a popover is a one-line change and the rest of
 * that component — its outside-click handler, its Escape handler, its aria
 * attributes — is untouched. A migration that required rewriting five menus
 * would be a migration that got applied to three of them.
 */
import { useCallback, useEffect, useState } from "react";
import { closePopover, currentPopover, openPopover, subscribePopovers } from "./popoverGroup";

export function useExclusivePopover(id: string): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(() => currentPopover() === id);

  useEffect(() => subscribePopovers((current) => setOpenState(current === id)), [id]);

  // Closing on unmount matters: a popover whose button is removed by a layout
  // change would otherwise leave the registry believing it is still open, and
  // the next popover would refuse to open.
  useEffect(() => () => closePopover(id), [id]);

  const setOpen = useCallback((next: boolean) => {
    if (next) openPopover(id); else closePopover(id);
  }, [id]);

  return [open, setOpen];
}
