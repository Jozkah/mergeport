"use client";

import { createContext, useContext, type ReactNode } from "react";

/** The page's CSP script nonce (read from the request in the root layout). An inline <script> without it is blocked. */
const NonceContext = createContext<string | undefined>(undefined);

export function CspNonceProvider({ nonce, children }: { nonce: string | undefined; children: ReactNode }) {
  return <NonceContext.Provider value={nonce}>{children}</NonceContext.Provider>;
}

export const useCspNonce = () => useContext(NonceContext);
