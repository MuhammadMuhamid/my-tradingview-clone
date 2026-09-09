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
    { media: "(prefers-color-scheme: light)", color: "#f8f9fd" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0e14" },
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
          <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
