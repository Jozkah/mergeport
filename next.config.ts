import type { NextConfig } from "next";

/** Host (with port) of MERGEPORT_PUBLIC_URL, or null for the local app. */
const publicHost = (() => {
  try {
    return process.env.MERGEPORT_PUBLIC_URL?.trim() ? new URL(process.env.MERGEPORT_PUBLIC_URL).host : null;
  } catch {
    return null;
  }
})();

const config: NextConfig = {
  poweredByHeader: false,
  compress: true,
  experimental: {
    // Hosted: a reverse proxy that rewrites Host makes Next's Origin-vs-Host check on Server Actions (onboarding, workspace switcher,
    // sign out everywhere) reject the browser's own origin. Name the public host so those forms work; nothing else is allowed.
    ...(publicHost ? { serverActions: { allowedOrigins: [publicHost] } } : {}),
    // Revisiting a page within 30 s (and going back) is instant from the client cache. Actions and live updates still refresh it.
    staleTimes: { dynamic: 30, static: 300 },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          // The Content-Security-Policy is set per request in src/proxy.ts (script-src needs a fresh nonce); the policy lives in src/lib/csp.ts.
        ],
      },
    ];
  },
};
export default config;
