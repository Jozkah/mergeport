/** A repository's name with a small colour dot that is always the same for that repository, so rows from different repositories can be told apart at a glance. */
export function repoHue(fullName: string): number {
  let h = 0;
  for (let i = 0; i < fullName.length; i++) h = (h * 31 + fullName.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function RepoChip({ fullName, number }: { fullName: string; number?: number }) {
  const [owner, name] = fullName.split("/");
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[11.5px] text-ink-3" title={fullName}>
      <span aria-hidden className="size-2 shrink-0 rounded-[3px]" style={{ background: `oklch(0.68 0.13 ${repoHue(fullName)})` }} />
      <span className="truncate"><span className="text-ink-3">{owner}/</span><span className="text-ink-2">{name ?? fullName}</span>{number !== undefined ? `#${number}` : ""}</span>
    </span>
  );
}
