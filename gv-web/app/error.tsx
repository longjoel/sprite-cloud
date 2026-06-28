"use client";

import { ErrorPage } from "@/components/ErrorPage";
import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[gv] app error:", error);
  }, [error]);

  return (
    <ErrorPage
      code={500}
      title="Something crashed"
      message={error.message || "An unexpected error occurred. Try refreshing the page."}
    />
  );
}
