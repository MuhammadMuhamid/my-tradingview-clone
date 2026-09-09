import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { ThemeToggle } from "@/components/ThemeToggle";

export const metadata: Metadata = {
  title: "Trading Scene",
  description: "Charting, screening, alerts, paper and Spot trading on Binance — the Trading Scene workstation",
  // The manifest is what makes "Add to Home Screen" produce a standalone app —
  // on iOS that installation is a hard prerequisite for Web Push.
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Trading Scene",
    statusBarStyle: "black-translucent",
  },
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};

/** Render at device width; allow pinch-zoom up to 5x for chart inspection. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  // Must match `bg` in tailwind.config.ts, or mobile Safari paints its chrome
  // a different near-black and the page appears to start with a seam.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ebebeb" },
    { media: "(prefers-color-scheme: dark)", color: "#2e2e2e" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Script src="/theme-init.js" strategy="beforeInteractive" />
        <div className="flex h-[100dvh] flex-col">
          {/* Visible only when focused; see .skip-link in globals.css. */}
          <a href="#main" className="skip-link">Skip to content</a>
          <Nav />
          <ThemeToggle />
          {/*
            A flex column, not a block.

            The chart workspace fills this element, and it used to do that with
            `h-full` — a percentage height, which resolves against the parent's
            SPECIFIED height. `main` is a flex item with `flex-1`, so its
            specified height is `auto` and the percentage fell back to the
            workspace's own content height: 890px inside a 900px `main`, a 10px
            band of page ground across the bottom of the workspace that grew or
            shrank with whatever was in the bottom panel. Making this a column
            lets the workspace say `flex-1` and actually mean it. Every other
            page's root is a single block that stretches to full width either
            way, so nothing else changes.

            `overflow-x-hidden` for the same reason `body` has it. This element
            is its own scroll container, and one pixel of sub-pixel rounding in
            a 52 + 1042 + 294 + 52 workspace row was enough to give it a
            horizontal scrollbar — which, at the 10px scrollbar this product
            styles, silently took 10px of height off the chart at every
            viewport. Wide tables and toolbars scroll in their own containers;
            the page never does.
          */}
          <main id="main" tabIndex={-1}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden outline-none">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
