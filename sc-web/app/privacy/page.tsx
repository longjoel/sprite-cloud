import { Link, Typography } from "@mui/material";
import { LegalPage } from "@/components/LegalPage";

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" updated="August 12, 2026">
      <Typography>This policy describes the Sprite Cloud project-operated gateway at sprite-cloud.com. A self-hosted gateway is controlled by its own operator, who is responsible for its privacy notices, configuration, retention, and legal obligations.</Typography>

      <section><Typography component="h2" variant="h5" gutterBottom>Information the gateway processes</Typography><Typography>For an account, the gateway stores your email address, display name, password hash, server memberships, invitation history, and account creation time. It also stores paired-server identity and status, a searchable game catalog supplied by your server, server-wide flags and cover choices, and short-lived command, session, room, and peer records needed to stream games.</Typography></section>

      <section><Typography component="h2" variant="h5" gutterBottom>ROMs and gameplay</Typography><Typography>ROM files, BIOS files, saves, and filesystem paths remain on the paired sc-server host. The gateway relays signaling and commands and stores game identifiers and operational state. WebRTC media normally travels between the player and host; configured STUN or TURN services may observe network addresses or relay encrypted WebRTC traffic when direct connectivity is unavailable.</Typography></section>

      <section><Typography component="h2" variant="h5" gutterBottom>Operational diagnostics</Typography><Typography>Sprite Cloud collects first-party operational diagnostics needed to secure, operate, and troubleshoot the service. These can include launch milestones, bounded browser console/error details, page path with room and invitation secrets redacted, browser and connection characteristics, IP address, and user agent. Launch telemetry, completed commands, and ended sessions are configured for cleanup after about one hour; infrastructure logs may follow the gateway operator's separate log-retention configuration.</Typography></section>

      <section><Typography component="h2" variant="h5" gutterBottom>Optional analytics</Typography><Typography>If PostHog is configured and you choose Allow analytics, the browser sends pseudonymous pageview and click/button interaction events to that configured PostHog service. PostHog assigns a random browser identifier and, like other network services, may receive request metadata such as IP address and user agent. Session recording, typed-input capture, and identified person profiles are disabled. PostHog does not initialize before opt-in. You can revoke consent through Privacy choices in the footer.</Typography></section>

      <section><Typography component="h2" variant="h5" gutterBottom>External services and disclosures</Typography><Typography>Cover searches and imports make server-side requests to the Libretro thumbnail service using the selected platform, artwork category, and search title. Links to GitHub, Discord, social networks, YouTube, and the project blog are external; their policies apply after you follow a link. Information may be disclosed when required by law, to protect the service and users, or to infrastructure providers acting for the operator.</Typography></section>

      <section><Typography component="h2" variant="h5" gutterBottom>Your choices and requests</Typography><Typography>You can reject optional analytics without losing core functionality and change that choice later. Account and server administrators can remove servers and associated gateway records through the product. For access, correction, deletion, or privacy questions about the project-operated gateway, contact the project maintainer through the <Link href="https://github.com/longjoel/sprite-cloud" target="_blank" rel="noopener noreferrer">Sprite Cloud repository</Link> or community support channel. Requests concerning a self-hosted gateway must go to that gateway's operator.</Typography></section>

      <section><Typography component="h2" variant="h5" gutterBottom>Security, children, and changes</Typography><Typography>Sprite Cloud uses hashed passwords and server credentials, scoped authorization, CSRF protection, and bounded diagnostics, but no service can promise absolute security. The service is not directed to children under 13. Material policy changes will be reflected by updating this page and its date.</Typography></section>
    </LegalPage>
  );
}
