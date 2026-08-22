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
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
