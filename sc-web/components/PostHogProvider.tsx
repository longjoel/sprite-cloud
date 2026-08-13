"use client";

// Client-side PostHog wiring for the App Router.
//
// Renders children unconditionally and is a strict no-op unless PostHog was
// actually configured at build time (see lib/posthog.ts). Captures a
// $pageview on mount and on every route change so DAU + navigation trends
// work without the SDK's own history listener.

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { initPostHog, isPostHogActive, posthog } from "@/lib/posthog";
import { disablePostHog } from "@/lib/posthog";
import { PRIVACY_CONSENT_EVENT, readPrivacyConsent } from "@/lib/privacy-consent";

export default function PostHogProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  useEffect(() => {
    initPostHog();
    const update = () => {
      if (readPrivacyConsent() === "analytics") {
        const started = initPostHog();
        if (started) posthog.capture("$pageview", { path: pathname ?? "/" });
      }
      else disablePostHog();
    };
    window.addEventListener(PRIVACY_CONSENT_EVENT, update);
    return () => window.removeEventListener(PRIVACY_CONSENT_EVENT, update);
  }, [pathname]);

  useEffect(() => {
    if (!isPostHogActive()) return;
    posthog.capture("$pageview", { path: pathname ?? "/" });
  }, [pathname]);

  return <>{children}</>;
}
