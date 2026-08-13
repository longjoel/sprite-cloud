export const CONSENT_STORAGE_KEY = "sc:privacy-consent:v1";
export const PRIVACY_CONSENT_EVENT = "sc:privacy-consent";
export const OPEN_PRIVACY_CHOICES_EVENT = "sc:open-privacy-choices";

export type PrivacyConsent = "necessary" | "analytics";

export function clearLegacyAnalyticsStorage(): void {
  if (typeof window === "undefined") return;
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith("ph_") && key !== CONSENT_STORAGE_KEY) window.localStorage.removeItem(key);
    }
  } catch { /* storage may be unavailable */ }
  for (const entry of document.cookie.split(";")) {
    const name = entry.trim().split("=", 1)[0];
    if (name.startsWith("ph_")) document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
  }
}

export function readPrivacyConsent(): PrivacyConsent | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    return value === "necessary" || value === "analytics" ? value : null;
  } catch {
    return null;
  }
}

export function writePrivacyConsent(value: PrivacyConsent): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(CONSENT_STORAGE_KEY, value); } catch { /* preference remains session-only */ }
  if (value === "necessary") clearLegacyAnalyticsStorage();
  window.dispatchEvent(new CustomEvent(PRIVACY_CONSENT_EVENT, { detail: value }));
}

export function openPrivacyChoices(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_PRIVACY_CHOICES_EVENT));
}
