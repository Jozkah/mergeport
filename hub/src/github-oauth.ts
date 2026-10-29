import { z } from "zod";
import type { HubConfig } from "./config";
import { HttpError } from "./http";

type OauthCfg = Pick<HubConfig, "githubClientId" | "githubOauthBase" | "githubApiBase">;

export type DeviceStart = { deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number };
export type DevicePoll = { kind: "pending" } | { kind: "slow_down" } | { kind: "expired" } | { kind: "denied" } | { kind: "token"; accessToken: string };
export type GithubUser = { id: bigint; login: string; name: string | null; avatarUrl: string | null };

async function postForm(url: string, body: Record<string, string>): Promise<unknown> {
  let r: Response;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
  } catch {
    throw new HttpError(502, "github unreachable");
  }
  if (!r.ok) throw new HttpError(502, "github error");
  try {
    return await r.json();
  } catch {
    throw new HttpError(502, "github error");
  }
}

const startSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  interval: z.number(),
  expires_in: z.number(),
});

export async function startDeviceFlow(cfg: OauthCfg): Promise<DeviceStart> {
  const parsed = startSchema.safeParse(await postForm(`${cfg.githubOauthBase}/login/device/code`, { client_id: cfg.githubClientId, scope: "read:user" }));
  if (!parsed.success) throw new HttpError(502, "github error");
  const d = parsed.data;
  return { deviceCode: d.device_code, userCode: d.user_code, verificationUri: d.verification_uri, interval: d.interval, expiresIn: d.expires_in };
}

const pollSchema = z.object({ access_token: z.string().optional(), error: z.string().optional() });

export async function pollDeviceFlow(cfg: OauthCfg, deviceCode: string): Promise<DevicePoll> {
  const parsed = pollSchema.safeParse(
    await postForm(`${cfg.githubOauthBase}/login/oauth/access_token`, {
      client_id: cfg.githubClientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  );
  if (!parsed.success) throw new HttpError(502, "github error");
  const { access_token, error } = parsed.data;
  if (access_token) return { kind: "token", accessToken: access_token };
  switch (error) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow_down" };
    case "access_denied":
      return { kind: "denied" };
    case "expired_token":
    case "bad_verification_code":
      return { kind: "expired" };
    case "incorrect_device_code":
      throw new HttpError(400, "invalid device code");
    default:
      throw new HttpError(502, "github error");
  }
}

/** Ids may exceed 2^53, so parse the id from raw text instead of JSON.parse's double. */
export async function fetchGithubUser(cfg: OauthCfg, accessToken: string): Promise<GithubUser> {
  let r: Response;
  try {
    r = await fetch(`${cfg.githubApiBase}/user`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${accessToken}`, "user-agent": "mergeport-hub" } });
  } catch {
    throw new HttpError(502, "github unreachable");
  }
  if (!r.ok) throw new HttpError(502, "github error");
  const text = await r.text();
  const idMatch = /"id"\s*:\s*(\d+)/.exec(text);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(502, "github error");
  }
  const parsed = z.object({ login: z.string(), name: z.string().nullable().optional(), avatar_url: z.string().nullable().optional() }).safeParse(body);
  if (!parsed.success || !idMatch) throw new HttpError(502, "github error");
  return { id: BigInt(idMatch[1]), login: parsed.data.login, name: parsed.data.name ?? null, avatarUrl: parsed.data.avatar_url ?? null };
}
