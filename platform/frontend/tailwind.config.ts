import type { Config } from "tailwindcss";

// Dark trading-desk theme. Categorical/status hues come from the dataviz
// reference palette (validated), used only for data marks — text stays on ink tokens.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b0e14",
        surface: "#121722",
        "surface-2": "#1a2030",
        border: "#232b3a",
        ink: "#e6e9ef",
        "ink-muted": "#9aa4b6",
        "ink-faint": "#6b7486",
        accent: "#4f8cff",
        up: "#2ebd85",     // long / profit (status good)
        down: "#f6465d",   // loss (status critical)
        /*
         * FE-11: `warn` was used in three components — the OPEN TRADE banner on
         * a backtest, the same banner in the strategy tester, and the OPEN row
         * in the trade list — but was never defined here. Tailwind emits no
         * rule for an unknown token, so `text-warn` produced no colour,
         * `bg-warn/10` no background and `border-warn/40` no border: the badge
         * marking the one trade still holding risk rendered as plain body text.
         *
         * Amber, because this is neither profit nor loss: it is a position
         * whose outcome is not known yet. 9.7:1 against the surface, so it
         * carries small text.
         */
        warn: "#f0b90b",   // unresolved / still at risk (status caution)
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
