import { Typography } from "@mui/material";
import { LegalPage } from "@/components/LegalPage";

export default function CookiesPage() {
  return (
    <LegalPage title="Cookie & storage notice" updated="August 12, 2026">
      <Typography>Sprite Cloud uses first-party cookies and browser storage. Necessary storage supports security and requested features and is active without consent. Optional analytics stays off unless you choose Allow analytics.</Typography>

      <section><Typography component="h2" variant="h5" gutterBottom>Necessary cookies</Typography><Typography><strong>authjs.session-token</strong> (or the secure <strong>__Secure-authjs.session-token</strong> variant) keeps signed-in sessions working. Auth.js may also use short-lived CSRF and callback cookies during sign-in. When you use sign-in, player, server-management, invitation, or API features, <strong>sc_csrf_token</strong> protects state-changing requests. Cookies named <strong>sc_host_&lt;game-id&gt;</strong> remember a chosen server for a game for up to one year. These cookies are first-party and are not advertising cookies.</Typography></section>

      <section><Typography component="h2" variant="h5" gutterBottom>Necessary local and session storage</Typography><Typography>localStorage stores library favorites and renames, controller key mappings, touch-controller layouts, visibility, opacity and size preferences, and this privacy choice. sessionStorage stores a random per-tab reconnect identifier used for player continuity. Removing this storage resets those preferences and may interrupt a session, but you can clear it in your browser settings.</Typography></section>

      <section><Typography component="h2" variant="h5" gutterBottom>Optional analytics storage</Typography><Typography>If PostHog is configured and you select Allow analytics, PostHog stores a random pseudonymous analytics identifier in localStorage and receives pageview and interaction events. Sprite Cloud configures PostHog to use localStorage rather than analytics cookies, disables session recording, and does not capture typed input. Selecting Necessary only prevents initialization; choosing it later opts out and resets the PostHog browser identity.</Typography></section>

      <section><Typography component="h2" variant="h5" gutterBottom>Managing choices</Typography><Typography>Use Privacy choices in any public footer to allow or reject optional analytics. Necessary only is the default until you make a choice. Browser controls can delete cookies and localStorage, but blocking necessary storage may prevent sign-in, security checks, remembered preferences, or gameplay features from working.</Typography></section>

      <section><Typography component="h2" variant="h5" gutterBottom>Self-hosted gateways</Typography><Typography>A self-hosted gateway can change cookie names, analytics configuration, and retention. Its operator must publish an accurate notice for that deployment.</Typography></section>
    </LegalPage>
  );
}
