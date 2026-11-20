import type { Db } from "@/lib/db";
import type { Mailer, MailMessage } from "@/lib/auth/mailer";

/**
 * Shared doubles for the account tests. The route handlers read cookies through next/headers and the shared `db`; here both are
 * backed by a per-test database and a plain Map, so a handler can run end to end outside a Next request.
 */
type Stored = { value: string; options: Record<string, unknown> };
export const state: { db: Db | null; jar: Map<string, Stored> } = { db: null, jar: new Map() };

export const dbProxy = new Proxy({} as Db, {
  get(_t, prop) {
    const c = state.db!;
    const v = Reflect.get(c, prop, c);
    return typeof v === "function" ? v.bind(c) : v;
  },
});

export const headersMock = {
  cookies: async () => ({
    get: (name: string) => (state.jar.has(name) ? { name, value: state.jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options: Record<string, unknown> = {}) => void state.jar.set(name, { value, options }),
    delete: (arg: string | { name: string }) => void state.jar.delete(typeof arg === "string" ? arg : arg.name),
  }),
};

export class RecordingMailer implements Mailer {
  sent: MailMessage[] = [];
  async send(m: MailMessage) {
    this.sent.push(m);
  }
  /** The sign-in link in the n-th (default last) message. */
  link(n = -1): string {
    const m = this.sent.at(n)!;
    return /https?:\/\/\S+/.exec(m.text)![0];
  }
  token(n = -1): string {
    return new URL(this.link(n)).searchParams.get("token")!;
  }
}

export const HOST = "app.test";
export const ORIGIN = `https://${HOST}`;
export const request = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`${ORIGIN}${path}`, { ...init, headers: { host: HOST, ...(init.headers ?? {}) } });

export const formPost = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  request(path, { method: "POST", body: new URLSearchParams(fields), headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", ...headers } });

export const locationOf = (res: Response) => res.headers.get("location") ?? "";
export const pathOf = (res: Response) => {
  const l = locationOf(res);
  return l.startsWith(ORIGIN) ? l.slice(ORIGIN.length) : l;
};

/** The random value the requesting browser keeps in its mp_ml cookie. */
export const NONCE = "browser-nonce-0123456789abcdef";
/** Puts the requesting browser's cookie in the jar, as it would be after asking for a link. */
export const withBrowser = (nonce = NONCE) => void state.jar.set("mp_ml", { value: nonce, options: {} });
