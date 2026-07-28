import InviteClient from "./InviteClient";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <InviteClient code={code} />;
}
