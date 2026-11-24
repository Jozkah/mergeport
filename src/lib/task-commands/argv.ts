/**
 * Strict argument parsing for the `mp` command. Every flag is declared; an unknown flag, a missing value or a repeated single-value
 * flag is an error, never ignored. Values are data: they are stored as given (after control characters are refused) and never interpreted.
 */
export class UsageError extends Error {}

export type FlagSpec = { kind: "bool" | "value" | "list" };
export type Parsed = { positionals: string[]; flags: Map<string, string | true | string[]> };

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export const hasControlChars = (s: string) => CONTROL.test(s);

export function parseArgs(argv: string[], spec: Record<string, FlagSpec>, maxPositionals: number): Parsed {
  const flags: Parsed["flags"] = new Map();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      positionals.push(tok);
      continue;
    }
    const eq = tok.indexOf("=");
    const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    const def = spec[name];
    if (!def) throw new UsageError(`Unknown flag --${name}`);
    if (def.kind === "bool") {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      flags.set(name, true);
      continue;
    }
    let value: string;
    if (eq !== -1) value = tok.slice(eq + 1);
    else {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && next.slice(2).split("=")[0] in spec)) throw new UsageError(`--${name} needs a value`);
      value = next;
      i++;
    }
    if (hasControlChars(value)) throw new UsageError(`--${name} contains control characters`);
    if (def.kind === "list") flags.set(name, [...((flags.get(name) as string[] | undefined) ?? []), value]);
    else {
      if (flags.has(name)) throw new UsageError(`--${name} was given twice`);
      flags.set(name, value);
    }
  }
  if (positionals.length > maxPositionals) throw new UsageError(`Unexpected argument "${positionals[maxPositionals]}"`);
  return { positionals, flags };
}

export const flagStr = (p: Parsed, n: string): string | undefined => {
  const v = p.flags.get(n);
  return typeof v === "string" ? v : undefined;
};
export const flagList = (p: Parsed, n: string): string[] => (p.flags.get(n) as string[] | undefined) ?? [];
export const flagBool = (p: Parsed, n: string): boolean => p.flags.get(n) === true;
