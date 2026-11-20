import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { PageHeader } from "@/components/ui/primitives";
import { LeavePanel, MembersPanel, SpacesPanel, TransferPanel } from "@/components/members/MembersPanels";
import { can } from "@/lib/authz/roles";
import { projectWhere } from "@/lib/authz/viewer";
import { isDemo } from "@/lib/env";
import { listSpacesForAdmin } from "@/lib/services/access-spaces";
import { listInvitations } from "@/lib/services/invitations";
import { listMembers } from "@/lib/services/members";

export const metadata = { title: "Members" };
export const dynamic = "force-dynamic";

/** Workspace membership: who is in, with which role, who is invited, and which spaces see what. Administrators manage; everyone sees their own membership. */
export default async function MembersPage() {
  const { viewer } = await requireViewer();
  if (isDemo()) notFound();
  const manage = can(viewer, "manageMembers");
  const [members, invitations, spaces, projects] = manage
    ? await Promise.all([
        listMembers(db, viewer),
        listInvitations(db, viewer),
        listSpacesForAdmin(db, viewer),
        db.project.findMany({ where: projectWhere(viewer), select: { id: true, name: true }, orderBy: { name: "asc" }, take: 200 }),
      ])
    : [[], [], [], []];
  const admins = members.filter((m) => m.status === "ACTIVE" && m.role === "ADMIN");
  return (
    <>
      <PageHeader title="Members" subtitle="Who belongs to this workspace, and what each person can do." help={<>Owner: everything, and the only one who can transfer ownership. Admin: members and spaces. Member: edits where a space allows it. Reader: looks only.</>} />
      <div className="flex flex-col gap-5">
        {manage && <MembersPanel viewer={viewer} members={members} invitations={invitations} />}
        {manage && <SpacesPanel spaces={spaces} members={members} projects={projects} />}
        {viewer.role === "OWNER" && <TransferPanel admins={admins} />}
        <LeavePanel role={viewer.role} />
      </div>
    </>
  );
}
