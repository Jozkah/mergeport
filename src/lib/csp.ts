/**
 * Content-Security-Policy for every page response. Built per request in proxy.ts because script-src carries a fresh nonce
 * (Next reads it from the request's CSP header and stamps its own inline bootstrap scripts and chunks with it).
 *
 *  - script-src: the nonce plus 'strict-dynamic' (chunks loaded by a trusted script inherit trust; 'self' is ignored by
 *    browsers that understand strict-dynamic and kept for older ones). No 'unsafe-inline' for scripts. 'unsafe-eval' is
 *    added only in `next dev`, where React uses eval for server stack reconstruction.
 *  - style-src keeps 'unsafe-inline': components set style= attributes (--sec custom properties, board sizing) and a nonce
 *    cannot cover attributes. Residual risk: injected CSS, not script.
 *  - img-src: this app, data: URIs, github.com (avatars redirect from github.com/<login>.png, user-attachments) and GitHub's
 *    *.githubusercontent.com hosts. Any other remote image in markdown is rendered as a link (see markdown.ts).
 *  - form-action: the two GitHub paths the GitHub App manifest form posts to (a path ending in / matches by prefix, the other
 *    is exact), not all of github.com. The submit is a top-level form navigation; without them the browser blocks it.
 */
export function buildCsp(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://github.com https://*.githubusercontent.com",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self' https://github.com/settings/apps/new https://github.com/organizations/",
  ].join("; ");
}

export function newNonce(): string {
  return btoa(crypto.randomUUID());
}
