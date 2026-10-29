"use client";

import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/Select";

/** Branch switcher for the code browser. Changing it reloads the same folder or file on the chosen branch. */
export function RefPicker({ repoId, path, current, branches }: { repoId: string; path: string; current: string; branches: string[] }) {
  const router = useRouter();
  const list = branches.includes(current) ? branches : [current, ...branches];
  return (
    <Select
      aria-label="Branch or commit"
      className="select !h-8 !w-auto min-w-40 !text-[13px]"
      value={current}
      onChange={(e) => router.push(`/repositories/${repoId}/code${path ? "/" + path.split("/").map(encodeURIComponent).join("/") : ""}?ref=${encodeURIComponent(e.target.value)}`)}
    >
      {list.map((b) => <option key={b} value={b}>{b.length > 40 ? b.slice(0, 12) : b}</option>)}
    </Select>
  );
}
