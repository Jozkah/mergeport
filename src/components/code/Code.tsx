import type { CSSProperties } from "react";
import type { Tok } from "@/lib/highlight";

/** Highlighted tokens as spans carrying the light and dark colour; uncoloured text stays a plain string. */
export function Tokens({ tok, palette }: { tok: Tok[]; palette: string[] }) {
  return (
    <>
      {tok.map(([text, i], k) => {
        if (i < 0 || !palette[i]) return text;
        const [l, d] = palette[i].split("|");
        return <span key={k} style={{ "--l": l || undefined, "--d": d || undefined } as CSSProperties}>{text}</span>;
      })}
    </>
  );
}
