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
        /*
         * TVP7. `surface-3` was referenced by `hover:bg-surface-3` on the
         * symbol pill and by a handful of panels but was never declared here,
         * so Tailwind emitted no rule and those hovers did nothing at all.
         *
         * The four below it are the workstation's state contract, declared so
         * a component can say `bg-state-active` instead of carrying a raw
         * `var()` in a class string. They are plain `var()` rather than
         * `<alpha-value>` triples deliberately: a state colour is used at full
         * opacity or not at all — it is the alpha-blended `accent/15` idiom
         * these replace that made selection read as a blue wash.
         */
        "surface-3": "var(--ts-surface-3)",
        "state-hover": "var(--ts-state-hover)",
        "state-active": "var(--ts-state-active)",
        popover: "var(--ts-popover)",
        "border-strong": "var(--ts-line-strong)",
        "control-border": "var(--ts-control-border)",
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
