import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "@/lib/db";

export type Vault = { encrypt(plain: string): string; decrypt(cipher: string): string };
export type StoredHubSession = { origin: string; token: string; githubId: bigint; login: string };

const ID = "session";

function restrictToCurrentUser(file: string): void {
  if (process.platform !== "win32") return;
  const user = process.env.USERNAME;
  if (!user) return;
  try {
    execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true,
    });
  } catch {
    // best effort: ACL tightening must never block startup
  }
}

function loadOrCreateKey(keyFile: string): Buffer {
  try {
    const existing = fs.readFileSync(keyFile);
    if (existing.length === 32) return existing;
  } catch {
    // fall through to create
  }
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  const key = randomBytes(32);
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  restrictToCurrentUser(keyFile);
  return key;
}

export function openVault(keyFile: string): Vault {
  const key = loadOrCreateKey(keyFile);
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(".");
    },
    decrypt(cipher) {
      const [v, iv, tag, data] = cipher.split(".");
      if (v !== "v1" || !iv || !tag || data === undefined) throw new Error("bad cipher");
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      d.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
    },
  };
}

export async function saveHubSession(db: Db, vault: Vault, s: StoredHubSession): Promise<void> {
  const data = { origin: s.origin, cipher: vault.encrypt(s.token), githubId: s.githubId, login: s.login };
  await db.hubSession.upsert({ where: { id: ID }, create: { id: ID, ...data }, update: data });
}

export async function loadHubSession(db: Db, vault: Vault): Promise<StoredHubSession | null> {
  const row = await db.hubSession.findUnique({ where: { id: ID } });
  if (!row) return null;
  try {
    return { origin: row.origin, token: vault.decrypt(row.cipher), githubId: row.githubId, login: row.login };
  } catch {
    return null;
  }
}

export async function clearHubSession(db: Db): Promise<void> {
  await db.hubSession.deleteMany({ where: { id: ID } });
}
