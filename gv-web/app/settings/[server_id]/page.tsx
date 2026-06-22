import { redirect } from "next/navigation";

// Old deep-linked server management pages now redirect to the
// consolidated settings page where everything lives inline.
export default function ServerSettingsRedirect({
  params,
}: {
  params: Promise<{ server_id: string }>;
}) {
  // We don't even await params — just redirect immediately.
  // The user can find their server on the settings list.
  redirect("/settings");
}
