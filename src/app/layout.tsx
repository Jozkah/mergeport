import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { THEME_COOKIE, parseTheme, themeAttribute } from "@/lib/theme";

export const metadata: Metadata = {
  title: { default: "Mergeport", template: "%s · Mergeport" },
  description: "Local-first control center for selected GitHub repositories",
  robots: { index: false, follow: false },
};

/** Browser chrome follows the CHOSEN theme; with "system" it follows the OS. */
export async function generateViewport(): Promise<Viewport> {
  const pref = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return {
    width: "device-width",
    initialScale: 1,
    themeColor:
      pref === "light" ? "#f8f8f8" : pref === "dark" ? "#0e1013" : [{ media: "(prefers-color-scheme: light)", color: "#f8f8f8" }, { media: "(prefers-color-scheme: dark)", color: "#0e1013" }],
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The explicit choice is rendered into the first byte of HTML, so there is no flash and nothing for hydration to fix.
  const attr = themeAttribute(parseTheme((await cookies()).get(THEME_COOKIE)?.value));
  return (
    <html lang="en" data-theme={attr}>
      <body>{children}</body>
    </html>
  );
}
