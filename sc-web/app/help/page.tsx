import { auth } from "@/lib/auth";
import HelpPage from "@/components/HelpPage";

export default async function Help() {
  const session = await auth();
  return (
    <HelpPage
      userName={session?.user?.name || session?.user?.email || null}
      authenticated={!!session?.user?.id}
    />
  );
}
