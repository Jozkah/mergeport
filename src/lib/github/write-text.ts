import { ValidationError } from "@/lib/errors";

/** The text a GitHub write sends: caps, plain-text check and the footer line. Import-free of the server, so the confirmation sheet can show exactly what will be sent. */

export const TITLE_MAX = 256;
export const BODY_MAX = 20_000;
export const FOOTER = "Created from Mergeport";
export const FOOTER_BLOCK = `---\n${FOOTER}`;

/** The body as sent: the person's text and, last, the footer line. Never added twice. */
export function withFooter(body: string): string {
  const t = body.replace(/\r\n/g, "\n").trimEnd();
  if (t.endsWith(FOOTER_BLOCK)) return t;
  return t ? `${t}\n\n${FOOTER_BLOCK}` : FOOTER_BLOCK;
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** Plain text only: no control or bidirectional-override characters, length caps. The title is one line. */
export function validateWriteText(input: { title?: string; body?: string }, o: { titleRequired?: boolean } = {}): { title?: string; body: string } {
  if (input.title !== undefined) {
    const t = input.title.trim();
    if (o.titleRequired && !t) throw new ValidationError("Give the issue a title");
    if (t.length > TITLE_MAX) throw new ValidationError(`The title can have at most ${TITLE_MAX} characters`);
    if (/[\r\n]/.test(t) || CONTROL.test(t)) throw new ValidationError("The title has characters that are not allowed");
  }
  const body = input.body ?? "";
  if (body.length > BODY_MAX) throw new ValidationError(`The text can have at most ${BODY_MAX.toLocaleString("en-US")} characters`);
  if (CONTROL.test(body.replace(/[\r\n\t]/g, ""))) throw new ValidationError("The text has characters that are not allowed");
  return { title: input.title?.trim(), body };
}

