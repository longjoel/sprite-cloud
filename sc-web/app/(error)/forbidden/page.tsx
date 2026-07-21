"use client";

import { ErrorPage } from "@/components/ErrorPage";

export default function ForbiddenPage() {
  return (
    <ErrorPage
      code={403}
      title="Access denied"
      message="You don't have permission to view this area. If you think this is a mistake, contact your server administrator."
    />
  );
}
