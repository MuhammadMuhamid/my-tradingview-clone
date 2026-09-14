/*
 * Split out of `ChartToolbar.tsx` so it can be imported by a test.
 *
 * It has to live under `components/` — tailwind.config.ts scans only
 * `./app` and `./components`, so a breakpoint literal written anywhere else
 * emits no CSS — but it does not have to live inside a client component
 * that pulls in React and thirty other modules. `lib/toolbarLayout` holds
 * the same rule as arithmetic; `tests/chartToolbar.test.ts` pins the literals
 * below against the constant there.
 */

/**
 * The bar's one collapse decision, as class names.
 *
 * TVP8: this used to be four branches — the viewport shifted by the manual
 * ticket's 341px and the widget panel's 300px, because both were flex
 * siblings of the toolbar's column and narrowed its row. The toolbar is now
 * the first full-width row of the workstation, above the rails, the chart and
 * the panel, so nothing narrows it and the only decision left is the phone
 * breakpoint: below `md` the workspace cluster, the saved-layout identity and
 * Trade live in the More strip.
 */
export function toolbarDensityClasses(): {
  cluster: string; clusterInMore: string; separator: string; separatorInMore: string;
} {
  return {
    cluster: "hidden md:flex",
    clusterInMore: "flex md:hidden",
    separator: "hidden md:inline-block",
    separatorInMore: "md:hidden",
  };
}
