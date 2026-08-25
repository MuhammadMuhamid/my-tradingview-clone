/**
 * Post-sign-in redirect validation.
 *
 * `/login?next=…` is attacker-supplied and was previously assigned straight to
 * `window.location.href`, which makes it both an open redirect and a
 * `javascript:` sink — one click away from executing script in the origin that
 * holds the session cookie.
 *
 * The rule is deliberately narrow: a target must be a single-slash absolute
 * path on this origin. Anything else falls back to the default. Protocol
 * targets, protocol-relative `//host` targets, backslash variants that some
 * browsers normalise to `//`, and control characters are all rejected rather
 * than sanitised, because a sanitising parser is exactly where these bugs live.
 */
export const DEFAULT_AFTER_LOGIN = "/chart";

/**
 * ASCII control characters, plus the space. Browsers strip tab/CR/LF from a URL
 * before parsing it, so a tab inside a scheme still parses as that scheme.
 * Matching control characters is the whole point here, hence the disable.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;

export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_AFTER_LOGIN;

  let value = raw;
  // A `next` that arrived percent-encoded must be judged on what it decodes to.
  try {
    value = decodeURIComponent(raw);
  } catch {
    return DEFAULT_AFTER_LOGIN;
  }

  if (CONTROL_OR_SPACE.test(value)) return DEFAULT_AFTER_LOGIN;
  if (!value) return DEFAULT_AFTER_LOGIN;

  // Must be an absolute path on this origin, and not protocol-relative.
  if (!value.startsWith("/")) return DEFAULT_AFTER_LOGIN;
  if (value.startsWith("//")) return DEFAULT_AFTER_LOGIN;
  if (value.includes("\\")) return DEFAULT_AFTER_LOGIN;

  // No scheme may appear before the first `/`, `?` or `#`.
  const head = value.split(/[/?#]/, 1)[0] ?? "";
  if (head.includes(":")) return DEFAULT_AFTER_LOGIN;

  // Never bounce back to the login page — that is a redirect loop.
  const path = value.split(/[?#]/, 1)[0] ?? "";
  if (path === "/login" || path.startsWith("/login/")) return DEFAULT_AFTER_LOGIN;

  return value;
}
