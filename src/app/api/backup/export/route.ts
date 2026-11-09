import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getAuth } from "@/lib/auth/current";
import { exportBackup } from "@/lib/services/backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The backup file, as a download. Administrators only; contains no credentials or folder paths. */
export async function GET() {
  const a = await getAuth();
  if (!a?.viewer) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  if (!a.viewer.isAdmin) return NextResponse.json({ error: "Only an administrator can export a backup." }, { status: 403 });
  const text = await exportBackup(db, a.viewer);
  return new Response(text, { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="mergeport-backup-${new Date().toISOString().slice(0, 10)}.json"`, "Cache-Control": "no-store" } });
}
