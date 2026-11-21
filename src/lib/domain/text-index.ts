/**
 * SQLite cannot filter inside JSON arrays or compare case-insensitively with `mode`, so list-valued fields that need
 * filtering keep a lowercase "|a|b|" index string next to the JSON value.
 */
export const indexList = (items: string[]): string => (items.length ? "|" + items.map((s) => s.toLowerCase()).join("|") + "|" : "");
export const indexNeedle = (item: string): string => "|" + item.toLowerCase() + "|";
/** Case-insensitive login equality. A missing login (null, undefined or empty) equals nothing, including another missing one. */
export const sameLogin = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();
