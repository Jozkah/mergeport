/**
 * Extra right-click entries an element can offer. Put the result of ctx([...]) in a `data-ctx` attribute; the app's own context
 * menu (src/components/ui/ContextMenu.tsx) lists them above the link and page entries. Links open in the same tab unless
 * `external` is set; `copy` puts the text on the clipboard.
 */
export type CtxItem = { label: string; href?: string; external?: boolean; copy?: string } | "sep";

export const ctx = (items: (CtxItem | false | null | undefined)[]): string => JSON.stringify(items.filter(Boolean));
