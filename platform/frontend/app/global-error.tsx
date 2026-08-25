"use client";
import { useEffect } from "react";

/**
 * The last resort: an error thrown by the root layout itself, which `error.tsx`
 * cannot catch because it renders inside that layout.
 *
 * It replaces the whole document, so it must supply its own `<html>` and
 * `<body>` and cannot use anything from the layout — including the stylesheet.
 * The styles are therefore inline, which is the one place in this application
 * where that is correct rather than lazy.
 */
export default function GlobalError({
  error, reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => { console.error("[root error]", error); }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0b0e14", color: "#e6e9ef",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif" }}>
        <div style={{ display: "flex", minHeight: "100vh", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: "1rem", padding: "1rem",
          textAlign: "center" }}>
          <h1 style={{ fontSize: "1.125rem", fontWeight: 600, margin: 0 }}>
            The application failed to start
          </h1>
          <p style={{ fontSize: "0.875rem", color: "#9aa4b6", margin: 0, maxWidth: "32rem" }}>
            This is a display failure in the browser. Nothing was sent to your bot and no orders
            were affected.
          </p>
          <pre style={{ maxWidth: "32rem", overflow: "auto", background: "#1a2030",
            border: "1px solid #232b3a", borderRadius: "0.375rem", padding: "0.5rem 0.75rem",
            fontSize: "0.75rem", color: "#9aa4b6", textAlign: "left" }}>
            {error.message || "Unknown error"}
          </pre>
          <button
            onClick={reset}
            style={{ background: "#4f8cff", color: "#fff", border: 0, borderRadius: "0.375rem",
              padding: "0.375rem 1rem", fontSize: "0.875rem", fontWeight: 500, cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
