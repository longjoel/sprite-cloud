"use client";

import { Suspense } from "react";
import { ErrorPage } from "@/components/ErrorPage";
import { useSearchParams } from "next/navigation";

function UnauthorizedContent() {
  const params = useSearchParams();
  const from = params.get("from") || "/signin";

  return (
    <ErrorPage
      code={401}
      title="No save file"
      message="You need to sign in to access this area. Your session may have expired — sign back in to continue where you left off."
      action={{ label: "Sign in", href: from }}
    />
  );
}

export default function UnauthorizedPage() {
  return (
    <Suspense>
      <UnauthorizedContent />
    </Suspense>
  );
}
