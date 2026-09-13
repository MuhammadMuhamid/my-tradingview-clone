"use client";
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { Modal } from "./Modal";
import { Button, FIELD } from "./ui";

/*
 * ── The product's own confirmation and text entry ──────────────────────────
 *
 * TVP8: there were seventeen `window.confirm` and `window.prompt` calls across
 * the product — removing every drawing, deleting a watchlist, renaming a
 * layout, discarding a Pine draft, and the text of every Text, Note and
 * Callout drawing.
 *
 * Three things were wrong with that, and only one of them is cosmetic.
 *
 *   1. It is the single loudest tell that this is not the reference. A native
 *      sheet drops from the top of the browser window in the OS's font, with
 *      the ORIGIN printed above it — "localhost:3000 says". Nothing else in
 *      the product looks remotely like it. Placing one piece of text on a
 *      chart, the most ordinary thing a user does with the annotation tools,
 *      produced it.
 *   2. It cannot be styled, cannot say which drawing or which list it is
 *      about in the product's own words, has no destructive treatment on the
 *      button that destroys something, and offers "OK" for everything.
 *   3. It blocks the main thread. Every animation, every incoming tick and
 *      every socket callback stops until the user answers, which on a page
 *      built around a live chart is a real cost, not a theoretical one.
 *
 * So: one dialog, through the same `Modal` every other dialog in the product
 * uses — which means it already has the focus trap, Escape, restore-focus and
 * `role="dialog"` that `Modal`'s own docstring explains, and a native sheet
 * has nothing to do with.
 *
 * The API is deliberately promise-shaped, because that is what the seventeen
 * call sites were already written against:
 *
 *     if (window.confirm("…")) remove();      →   if (await confirm({…})) remove();
 *     const name = window.prompt("…", "");    →   const name = await promptFor({…});
 */

export interface ConfirmRequest {
  title: string;
  /** The sentence under the title. Say what will happen, not "Are you sure?". */
  body?: ReactNode;
  /** The verb on the button that does it. Defaults to "Confirm". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` paints the confirming button as destructive. */
  tone?: "default" | "danger";
}

export interface PromptRequest {
  title: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Reject empty input rather than returning "". Defaults to true. */
  required?: boolean;
  /** A textarea instead of a single line — for a note or a callout. */
  multiline?: boolean;
}

interface AskApi {
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  promptFor: (request: PromptRequest) => Promise<string | null>;
}

const AskContext = createContext<AskApi | null>(null);

type Pending =
  | { kind: "confirm"; request: ConfirmRequest; settle: (v: boolean) => void }
  | { kind: "prompt"; request: PromptRequest; settle: (v: string | null) => void };

export function AskProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  const api = useMemo<AskApi>(() => ({
    confirm: (request) => new Promise<boolean>((resolve) => {
      setPending({ kind: "confirm", request, settle: resolve });
    }),
    promptFor: (request) => new Promise<string | null>((resolve) => {
      setDraft(request.defaultValue ?? "");
      setPending({ kind: "prompt", request, settle: resolve });
    }),
  }), []);

  /*
   * A dialog that is dismissed ANY way — Escape, the backdrop, the close
   * button — has to settle its promise, or the caller waits forever and the
   * work it was guarding never happens and never fails either. `Modal` routes
   * all three through `onClose`, so there is one place to do it.
   */
  const close = useCallback((answer: boolean | string | null) => {
    setPending((current) => {
      if (!current) return null;
      if (current.kind === "confirm") current.settle(answer === true);
      else current.settle(typeof answer === "string" ? answer : null);
      return null;
    });
  }, []);

  // Focus the field, not the footer: a prompt exists to be typed into.
  useEffect(() => {
    if (pending?.kind !== "prompt") return;
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, [pending]);

  const request = pending?.request;
  const isPrompt = pending?.kind === "prompt";
  const promptRequest = isPrompt ? (pending.request as PromptRequest) : null;
  const emptyBlocked = promptRequest !== null
    && (promptRequest.required ?? true)
    && draft.trim() === "";

  const submit = (): void => {
    if (!pending) return;
    if (pending.kind === "confirm") { close(true); return; }
    if (emptyBlocked) return;
    close(draft);
  };

  return (
    <AskContext.Provider value={api}>
      {children}
      <Modal
        open={pending !== null}
        onClose={() => close(isPrompt ? null : false)}
        title={request?.title ?? ""}
        footer={
          <>
            <Button onClick={() => close(isPrompt ? null : false)}>
              {(!isPrompt && (request as ConfirmRequest | undefined)?.cancelLabel) || "Cancel"}
            </Button>
            <Button
              variant={!isPrompt && (request as ConfirmRequest | undefined)?.tone === "danger"
                ? "danger" : "primary"}
              onClick={submit}
              disabled={emptyBlocked}
            >
              {request && "confirmLabel" in request && request.confirmLabel
                ? request.confirmLabel
                : isPrompt ? "Save" : "Confirm"}
            </Button>
          </>
        }
      >
        {pending?.kind === "confirm" && pending.request.body !== undefined && (
          <p className="text-sm text-ink-muted">{pending.request.body}</p>
        )}
        {promptRequest && (
          <label className="block">
            {promptRequest.label && (
              <span className="mb-1 block text-xs text-ink-muted">{promptRequest.label}</span>
            )}
            {promptRequest.multiline ? (
              <textarea
                ref={inputRef as React.RefObject<HTMLTextAreaElement>}
                className={`${FIELD} block w-full resize-y py-1.5`}
                rows={3}
                value={draft}
                placeholder={promptRequest.placeholder}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Enter submits, Shift+Enter is a newline — the usual bargain
                  // for a field that is one line of text nine times in ten.
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
                }}
              />
            ) : (
              <input
                ref={inputRef as React.RefObject<HTMLInputElement>}
                className={`${FIELD} block w-full`}
                value={draft}
                placeholder={promptRequest.placeholder}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
              />
            )}
          </label>
        )}
      </Modal>
    </AskContext.Provider>
  );
}

/**
 * The product's confirmation and text entry.
 *
 * Outside the provider this throws rather than silently falling back to the
 * native sheet — a fallback would let a page drift back out of the product's
 * own grammar without anyone noticing, which is how there came to be
 * seventeen of them.
 */
export function useAsk(): AskApi {
  const api = useContext(AskContext);
  if (!api) throw new Error("useAsk must be used inside <AskProvider>");
  return api;
}
