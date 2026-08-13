import { Link, Typography } from "@mui/material";
import { LegalPage } from "@/components/LegalPage";

export default function TermsPage() {
  return (
    <LegalPage title="Terms of use" updated="August 12, 2026">
      <Typography>These terms apply to use of the Sprite Cloud project-operated gateway at sprite-cloud.com. A self-hosted gateway may be governed by separate terms from its operator.</Typography>

      <section><Typography component="h2" variant="h5" gutterBottom>Eligibility and accounts</Typography><Typography>You must be legally able to agree to these terms. Keep account, invitation, pairing, room, and server credentials confidential. You are responsible for activity through your account and paired servers and must promptly report suspected unauthorized access.</Typography></section>

      <section><Typography component="h2" variant="h5" gutterBottom>Your content and legal use</Typography><Typography>You retain any rights you hold in content you provide. Sprite Cloud does not grant rights to ROMs, BIOS files, artwork, manuals, saves, emulator cores, or other game content. You must use only content you have the legal right to use, comply with applicable copyright and other laws, and avoid using the service to distribute infringing or unlawful material.</Typography></section>

      <section><Typography component="h2" variant="h5" gutterBottom>Acceptable use</Typography><Typography>Do not attack, probe, overload, disrupt, reverse engineer credentials, bypass access controls, impersonate others, abuse invitations or public rooms, introduce malware, or use Sprite Cloud in a way that harms users, hosts, infrastructure, or third parties. Access may be limited or terminated to protect the service or enforce these terms.</Typography></section>

      <section><Typography component="h2" variant="h5" gutterBottom>Open-source software</Typography><Typography>The Sprite Cloud software is licensed under the <Link href="https://github.com/longjoel/sprite-cloud/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">GNU Affero General Public License version 3 or later</Link>, except for separately identified third-party components. If you operate a modified network version, the AGPL may require you to offer users its corresponding source code. These service terms do not replace or restrict rights granted by the software licenses.</Typography></section>

      <section><Typography component="h2" variant="h5" gutterBottom>Service availability</Typography><Typography>Sprite Cloud is early-stage software and the hosted gateway is provided on an “as is” and “as available” basis without warranties of uninterrupted availability, fitness, merchantability, non-infringement, data preservation, or compatibility. Back up saves, configuration, and other important data. Features and these terms may change as the project develops.</Typography></section>

      <section><Typography component="h2" variant="h5" gutterBottom>Liability</Typography><Typography>To the maximum extent permitted by law, Joel Longanecker, Sprite Cloud contributors, and service operators are not liable for indirect, incidental, special, consequential, exemplary, or lost-data damages arising from use or inability to use the software or gateway. Rights that cannot lawfully be excluded remain unaffected.</Typography></section>

      <section><Typography component="h2" variant="h5" gutterBottom>Contact and complete agreement</Typography><Typography>Questions about the project-operated gateway may be raised through the <Link href="https://github.com/longjoel/sprite-cloud" target="_blank" rel="noopener noreferrer">project repository</Link> or community support channel. The software licenses, privacy policy, cookie &amp; storage notice, and these terms form the relevant public documents; self-hosted operators remain responsible for their own service terms.</Typography></section>
    </LegalPage>
  );
}
