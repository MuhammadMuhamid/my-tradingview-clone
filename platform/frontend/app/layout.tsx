import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "SR+Trend Platform",
  description: "Charting, backtesting and live alerting for the MA + R:R strategy on Binance",
  // The manifest is what makes "Add to Home Screen" produce a standalone app —
  // on iOS that installation is a hard prerequisite for Web Push.
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "SR+Trend",
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
  themeColor: "#0b0e14",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="flex h-[100dvh] flex-col">
          <Nav />
          <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
        </div>
      </body>
    </html>
  );
}
