import type { Config } from "tailwindcss";

const token = (name: string): string => `rgb(var(--ts-${name}-rgb) / <alpha-value>)`;

// Semantic tokens resolve through the root theme, including opacity utilities.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: token("bg"),
        surface: token("surface"),
        "surface-2": token("surface-2"),
        border: token("line"),
        ink: token("ink"),
        "ink-muted": token("ink-muted"),
        "ink-faint": token("ink-faint"),
        accent: token("accent"),
        up: token("positive"),
        down: token("negative"),
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
        warn: token("caution"),
      },
      /*
       * FC2-H2: `sans` is declared, not inherited from Tailwind's default, so
       * the DOM and the chart canvas (`lib/chartTheme.ts`, which cannot read a
       * custom property) resolve to one face. `mono` stays — it is still
       * correct for the Pine editor and for raw JSON payloads, which is the
       * only place it is now used.
       */
      fontFamily: {
        sans: ["var(--ts-font-ui)"],
        mono: ["var(--ts-font-code)"],
      },
    },
  },
  plugins: [],
};
export default config;
