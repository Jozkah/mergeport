import { GithubError } from "./port";

/**
 * Minimal GitHub REST client over any `fetch` (gh-backed, or the in-memory fake in tests).
 * Errors become typed GithubErrors: rate-limited, not-found, forbidden, auth, network.
 */

export type RestResponse<T = unknown> = { status: number; data: T; headers: Headers };

export class GitHubRest {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly base = "https://api.github.com",
  ) {}

  async request<T = any>(method: string, path: string, body?: unknown, extra: { headers?: Record<string, string>; allow?: number[] } = {}): Promise<RestResponse<T>> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        method,
        headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(extra.headers ?? {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new GithubError("network", "Could not reach GitHub");
    }
    const text = res.status === 204 || res.status === 304 ? "" : await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (res.ok || res.status === 304 || extra.allow?.includes(res.status)) return { status: res.status, data: data as T, headers: res.headers };
    // The profile's own account could not be used (bound.ts): keep the specific, actionable reason.
    if (res.headers.get("x-mergeport-identity")) throw new GithubError("auth", String((data as { message?: string } | undefined)?.message ?? "Reconnect the GitHub account for this profile."), undefined, undefined, 401);
    throw mapHttpError(res.status, res.headers, data);
  }

  get<T = any>(path: string, extra?: { headers?: Record<string, string>; allow?: number[] }) {
    return this.request<T>("GET", path, undefined, extra);
  }

  /** Follows Link rel="next" up to `maxPages`. */
  async paginate<T = any>(path: string, maxPages = 20): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = path + (path.includes("?") ? "&" : "?") + "per_page=100";
    for (let i = 0; next && i < maxPages; i++) {
      const r: RestResponse<T[]> = await this.get<T[]>(next);
      out.push(...(Array.isArray(r.data) ? r.data : []));
      const m = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get("link") ?? "");
      next = m ? m[1].replace(this.base, "") : null;
    }
    return out;
  }
}

export function mapHttpError(status: number, headers: Headers, data: unknown): GithubError {
  const message = String((data as { message?: string } | undefined)?.message ?? `HTTP ${status}`);
  const resetHeader = headers.get("x-ratelimit-reset");
  const resetAt = resetHeader ? new Date(Number(resetHeader) * 1000) : undefined;
  const retryAfter = headers.get("retry-after");
  if ((status === 403 || status === 429) && (retryAfter || headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(message))) {
    const secs = retryAfter ? Number(retryAfter) : resetAt ? Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)) : 60;
    return new GithubError("rate-limited", message, secs, resetAt, status);
  }
  if (status === 401) return new GithubError("auth", "GitHub rejected the credential. Run gh auth login again.", undefined, undefined, status);
  if (status === 403) return new GithubError("forbidden", message, undefined, undefined, status);
  if (status === 404) return new GithubError("not-found", "Not found, or not accessible to this account", undefined, undefined, status);
  return new GithubError("unknown", `${status}: ${message}`, undefined, undefined, status);
}
