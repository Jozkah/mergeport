"use client";

import { useState } from "react";

/** GitHub serves a profile picture for any account at this address; bots (`name[bot]`) live under /apps. */
export function githubAvatarUrl(login: string, size: number): string | null {
  if (!login || login === "?") return null;
  const px = Math.min(460, Math.max(40, Math.round(size * 2))); // twice the display size keeps it sharp on dense screens
  if (/\[bot\]$/i.test(login)) return `https://github.com/apps/${encodeURIComponent(login.replace(/\[bot\]$/i, ""))}.png?size=${px}`;
  return `https://github.com/${encodeURIComponent(login)}.png?size=${px}`;
}

/**
 * A person's GitHub picture: the stored one when there is one, otherwise GitHub's public address for that login, and the
 * initials only if the picture cannot be loaded (offline, deleted account). The initials are also what shows while it loads.
 */
export function Avatar({ login, url, size = 22 }: { login: string; url?: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  const src = url || githubAvatarUrl(login, size);
  const initials = login.slice(0, 2).toUpperCase();
  const box = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)) };
  return (
    <span aria-hidden className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-muted font-medium text-ink-2" style={box}>
      {initials}
      {src && !failed && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="absolute inset-0 size-full rounded-full object-cover" />
      )}
    </span>
  );
}
