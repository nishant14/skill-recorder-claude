/**
 * Shared address-bar value → URL normalization for the host-based URL providers
 * (Windows UIA, Linux AT-SPI). Both read a *rendered* address bar rather than a
 * scripting API, so both see the same two problems: the browser hides the scheme,
 * and the same control holds search terms when the user is typing. One copy keeps
 * the two platforms from drifting into different ideas of what counts as a URL.
 */

/** Normalize an omnibox value into a parseable URL, or null if it's not one. */
export function normalizeUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  // Address bars usually drop the scheme ("github.com/foo"). Restore it so the
  // consumer can parse a host. Reject anything that still looks like a search
  // (has whitespace, or no dot) rather than emit noise.
  if (!/\s/.test(v) && v.includes(".")) return `https://${v}`;
  return null;
}
