import type { ComponentType, ReactNode, SVGProps } from "react";
import { Crown, Eye, Lock, Shield, User, Users } from "./icons";
import { ROLE_LABEL } from "@/lib/authz/roles";
import type { Role } from "@/lib/authz/roles";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;

const ROLE_ICON: Record<Role, Icon> = { OWNER: Crown, ADMIN: Shield, MEMBER: User, READER: Eye };

/** What a person is allowed to be here. Neutral tone: a role is a fact, not a state, so it never borrows a status colour. */
export function RoleChip({ role }: { role: Role }) {
  const I = ROLE_ICON[role] ?? User;
  return (
    <span className="pill pill-neutral">
      <I size={12} aria-hidden />
      {ROLE_LABEL[role] ?? role}
    </span>
  );
}

const SCOPE: Record<"restricted" | "everyone" | "readonly", { icon: Icon; label: string }> = {
  restricted: { icon: Lock, label: "Restricted" },
  everyone: { icon: Users, label: "Everyone" },
  readonly: { icon: Eye, label: "Read only" },
};

/** Who can see something (a project space) or how a link may be used. Neutral for the same reason as RoleChip. */
export function ScopeChip({ scope, children }: { scope: keyof typeof SCOPE; children?: ReactNode }) {
  const s = SCOPE[scope];
  const I = s.icon;
  return (
    <span className="pill pill-neutral">
      <I size={12} aria-hidden />
      {children ?? s.label}
    </span>
  );
}

/** The text of a peer origin for display: the scheme is dropped, the host truncates and the full origin is in the tooltip. */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * A peer instance's address. By default the scheme is stripped (the host is what identifies it) and the text truncates with the
 * full origin in `title`. Where trust matters (consent, linking) pass `showScheme`, so "http" is never hidden.
 */
export function Host({ origin, showScheme = false, className = "" }: { origin: string; showScheme?: boolean; className?: string }) {
  return (
    // Keyboard and touch cannot hover for the `title`: the span is focusable and the full origin is also read out.
    <span className={`inline-block max-w-full truncate align-bottom font-mono ${className}`} title={origin} translate="no" tabIndex={0} aria-label={origin}>
      <bdi>{showScheme ? origin.replace(/\/$/, "") : hostOf(origin)}</bdi>
    </span>
  );
}
