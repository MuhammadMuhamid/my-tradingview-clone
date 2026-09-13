/*
 * Split out of `ChartToolbar.tsx` so it can be imported by a test.
 *
 * It has to live under `components/` — tailwind.config.ts scans only
 * `./app` and `./components`, so a breakpoint literal written anywhere else
 * emits no CSS — but it does not have to live inside a client component
 * that pulls in React and thirty other modules. `lib/toolbarLayout` holds
 * the same rule as arithmetic; `tests/chartToolbar.test.ts` pins every
 * literal below against the constants there.
 */
/**
 * The bar's two collapse decisions, as class names.
 *
 * `md:` and `xl:` ask about the VIEWPORT. This row is not the viewport: open
 * the manual ticket and `ChartSidePanel` becomes a static flex sibling that
 * takes 341px out of this column, so at a 1280px screen the row is 939px wide
 * while `xl:` has already turned every text label on. The row then overflowed
 * its column and the saved-layout identity was painted over the ticket's own
 * instrument header — two live controls, one on top of the other.
 *
 * So when the ticket is open the same two decisions are made against the same
 * two widths shifted by the ticket's own width: `md` at 768+341=1109 and `xl`
 * at 1280+341=1621. With the ticket closed nothing changes at all.
 *
 * The literals live here rather than in `lib/toolbarLayout` because
 * tailwind.config.ts only scans app/ and components/, so a class name written
 * anywhere else emits no CSS. `toolbarDensity` there is the same rule as a
 * function, and chartToolbar.test.ts pins the two against each other.
 */
export function toolbarDensityClasses(ticketOpen: boolean, panelOpen = false): {
  label: string; cluster: string; clusterInMore: string;
  separator: string; separatorInMore: string;
} {
  /*
   * Four combinations, written out as literals.
   *
   * Both decisions are the same arithmetic — `768 + shift` for the cluster and
   * `1536 + shift` for the labels, where `shift` is 341 for the ticket and 300
   * for the widget panel — and `toolbarDensity` in `lib/toolbarLayout` is that
   * arithmetic. It cannot be written as arithmetic HERE: tailwind.config.ts
   * only emits the classes it can see in the source, so a breakpoint composed
   * at runtime produces no CSS at all.
   *
   * The first version of the panel case shifted only the LABEL decision and
   * left the cluster on `md`, so between 768 and 1068 with a panel open the
   * model said the cluster did not fit and the CSS showed it anyway — and with
   * BOTH open the CSS shifted by the ticket alone. The test now pins every one
   * of these literals against the constants, which is what the previous claim
   * said and did not do.
   */
  if (ticketOpen && panelOpen) {
    return {
      label: "hidden min-[2177px]:inline",
      cluster: "hidden min-[1409px]:flex",
      clusterInMore: "flex min-[1409px]:hidden",
      separator: "hidden min-[1409px]:inline-block",
      separatorInMore: "min-[1409px]:hidden",
    };
  }
  if (ticketOpen) {
    return {
      label: "hidden min-[1877px]:inline",
      cluster: "hidden min-[1109px]:flex",
      clusterInMore: "flex min-[1109px]:hidden",
      separator: "hidden min-[1109px]:inline-block",
      separatorInMore: "min-[1109px]:hidden",
    };
  }
  if (panelOpen) {
    return {
      label: "hidden min-[1836px]:inline",
      cluster: "hidden min-[1068px]:flex",
      clusterInMore: "flex min-[1068px]:hidden",
      separator: "hidden min-[1068px]:inline-block",
      separatorInMore: "min-[1068px]:hidden",
    };
  }
  return {
    label: "hidden 2xl:inline",
    cluster: "hidden md:flex",
    clusterInMore: "flex md:hidden",
    separator: "hidden md:inline-block",
    separatorInMore: "md:hidden",
  };
}
