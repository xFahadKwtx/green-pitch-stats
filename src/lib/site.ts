/** Single canonical production origin for this site. */
export const SITE_URL = "https://almustatil.lovable.app";

/** Build an absolute canonical URL for a site-relative path. */
export function absoluteUrl(path: string): string {
  if (!path || path === "/") return `${SITE_URL}/`;
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
