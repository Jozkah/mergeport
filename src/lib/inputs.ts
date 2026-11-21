/**
 * Props for a free-text field that is not a sign-in field (search, filter, names, branches): the browser's autofill and spell
 * checker only get in the way there. Sign-in email keeps autocomplete="email".
 */
export const plainText = { autoComplete: "off", spellCheck: false } as const;
