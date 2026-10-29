import { NextResponse } from "next/server";
import { bootId } from "@/lib/local/boot-id";

export const dynamic = "force-dynamic";

/** Answers once this process is serving. No auth, no data: only which process this is. */
export function GET() {
  return NextResponse.json({ bootId: bootId() });
}
