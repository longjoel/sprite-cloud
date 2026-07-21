"use client";

import { ErrorPage } from "@/components/ErrorPage";

export default function NotFound() {
  return (
    <ErrorPage
      code={404}
      title="ROM not found"
      message="The page you're looking for doesn't exist. It may have been moved, deleted, or the cartridge was never inserted."
    />
  );
}
