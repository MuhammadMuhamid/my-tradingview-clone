/**
 * The App Router's client contexts, supplied by hand.
 *
 * `useSearchParams()` and `usePathname()` read a context that the Next runtime
 * provides around every page. A page rendered on its own gets `null` from
 * them, which is not a defect in the page — so a test that renders one must
 * provide what the framework would. These are Next's own context objects, not
 * substitutes: the hooks under test are the real ones.
 */
import type { ReactNode } from "react";
import {
  PathnameContext, PathParamsContext, SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";

export function AppRoute(
  { path = "/", query = "", children }: { path?: string; query?: string; children: ReactNode }
) {
  const params = new URLSearchParams(query);
  return (
    <PathnameContext.Provider value={path}>
      <PathParamsContext.Provider value={{}}>
        <SearchParamsContext.Provider value={params as unknown as never}>
          {children}
        </SearchParamsContext.Provider>
      </PathParamsContext.Provider>
    </PathnameContext.Provider>
  );
}
