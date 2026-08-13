"use client";

import Link from "next/link";
import { Box, Container, Link as MuiLink, Stack, Typography } from "@mui/material";
import { openPrivacyChoices } from "@/lib/privacy-consent";

export default function LegalFooter() {
  return (
    <Box component="footer" sx={{ mt: "auto", borderTop: 1, borderColor: "divider", py: 3 }}>
      <Container maxWidth="lg">
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ alignItems: { xs: "flex-start", sm: "center" }, justifyContent: "space-between" }}>
          <Box>
            <Typography variant="overline" color="primary" sx={{ display: "block" }}>Sprite Cloud</Typography>
            <Typography variant="caption" color="text.secondary">Self-hosted game streaming</Typography>
          </Box>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
            <Typography variant="caption" color="text.secondary">© {new Date().getFullYear()} Joel Longanecker and Sprite Cloud contributors</Typography>
            <Typography variant="caption" color="text.disabled">·</Typography>
            <MuiLink component={Link} href="/help" variant="caption" underline="hover">Setup guide</MuiLink>
            <Typography variant="caption" color="text.disabled">·</Typography>
            <MuiLink component={Link} href="/privacy" variant="caption" underline="hover">Privacy</MuiLink>
            <Typography variant="caption" color="text.disabled">·</Typography>
            <MuiLink component={Link} href="/cookies" variant="caption" underline="hover">Cookies &amp; storage</MuiLink>
            <Typography variant="caption" color="text.disabled">·</Typography>
            <MuiLink component={Link} href="/terms" variant="caption" underline="hover">Terms</MuiLink>
            <Typography variant="caption" color="text.disabled">·</Typography>
            <Box component="button" type="button" onClick={openPrivacyChoices} sx={{ border: 0, p: 0, bgcolor: "transparent", cursor: "pointer", color: "primary.main", font: "inherit", typography: "caption", textDecoration: "underline", textUnderlineOffset: "0.15em" }}>Privacy choices</Box>
            <Typography variant="caption" color="text.disabled">·</Typography>
            <MuiLink href="https://github.com/longjoel/sprite-cloud/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" variant="caption" underline="hover">AGPL license</MuiLink>
            <Typography variant="caption" color="text.disabled">·</Typography>
            <MuiLink href="https://github.com/longjoel/sprite-cloud" target="_blank" rel="noopener noreferrer" variant="caption" underline="hover">Source</MuiLink>
            <Typography variant="caption" color="text.disabled">·</Typography>
            <MuiLink href="https://discord.gg/zujXa48kyS" target="_blank" rel="noopener noreferrer" variant="caption" underline="hover">Discord</MuiLink>
          </Stack>
        </Stack>
      </Container>
    </Box>
  );
}
