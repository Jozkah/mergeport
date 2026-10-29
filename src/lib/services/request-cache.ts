import { cache } from "react";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { attention } from "./queries";

/** Per-request memo (React cache): layout and page share one attention computation for the same Viewer object. */
export const attentionFor = cache((v: Viewer) => attention(db, v));
