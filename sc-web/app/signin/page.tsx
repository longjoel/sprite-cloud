import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import SignInForm from "./SignInForm";

export default async function SignInPage() {
  const session = await auth();
  if (session?.user?.id) {
    redirect("/xmb");
  }

  return <SignInForm />;
}
