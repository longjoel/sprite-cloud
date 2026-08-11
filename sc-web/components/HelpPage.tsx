"use client";

import Link from "next/link";
import {
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  Container,
  Link as MuiLink,
  Stack,
  Typography,
} from "@mui/material";
import AppHeader from "@/components/fluent/AppHeader";

interface Step {
  num: number;
  title: string;
  desc: string;
  code?: string;
  link?: { label: string; href: string };
}

const STEPS: Step[] = [
  {
    num: 1,
    title: "Install the server",
    desc: "Run this one-liner on your gaming machine (Linux, Bazzite, Steam Deck, Raspberry Pi):",
    code: "curl -fsSL https://sprite-cloud.com/install.sh | bash",
  },
  {
    num: 2,
    title: "Create an account",
    desc: "Accounts are created through an invitation. Ask a server admin for an invite link, then use it to create your email and password account with a personal library and access to your game servers.",
    link: { label: "Get an invitation →", href: "https://discord.gg/zujXa48kyS" },
  },
  {
    num: 3,
    title: "Pair and play",
    desc: "Go to your dashboard, generate a pairing code. Run sc-server pair <code> on your machine to link it to your account. Point it at your ROM directory, open your library, and start streaming.",
  },
];

const FEATURES = [
  { icon: "🎮", title: "Your library", desc: "Browse and search your full retro game collection from any device." },
  { icon: "📺", title: "Browser streaming", desc: "No apps, no plugins. Your games stream directly to any modern browser." },
  { icon: "🔒", title: "Self-hosted", desc: "Your ROMs, your hardware, your rules. No cloud subscription, no monthly fees." },
  { icon: "👥", title: "Multiplayer ready", desc: "Share a link and play together. Multiple players can join your game session." },
  { icon: "📱", title: "Any device", desc: "Desktop, phone, tablet — the responsive player adapts to any screen." },
  { icon: "🎛️", title: "Touch gamepad", desc: "On-screen touch controls for phones and tablets. No controller required." },
];

interface HelpPageProps {
  userName?: string | null;
  authenticated?: boolean;
  isLanProxy?: boolean;
}

export default function HelpPage({ userName, authenticated = false, isLanProxy = false }: HelpPageProps) {
  return (
    <Box component="main" sx={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <AppHeader
        userName={userName || undefined}
        authenticated={authenticated}
        isLanProxy={isLanProxy}
      />

      <Container component="section" maxWidth="md" sx={{ py: { xs: 6, sm: 8 }, textAlign: "center" }}>
        <Typography variant="h2" gutterBottom>
          Setup guide
        </Typography>
        <Typography color="text.secondary" sx={{ maxWidth: 560, mx: "auto" }}>
          Sprite Cloud streams your games from your own hardware to any browser. No subscription,
          no cloud — just your ROMs, your rules.
        </Typography>
      </Container>

      <Container component="section" maxWidth="md" sx={{ pb: { xs: 6, sm: 8 } }}>
        <Typography variant="h4" component="h2" gutterBottom sx={{ textAlign: "center" }}>
          How to set up Sprite Cloud
        </Typography>
        <Stack divider={<Box sx={{ borderBottom: 1, borderColor: "divider" }} />}>
          {STEPS.map((step) => (
            <Stack key={step.num} id={step.num === 2 ? "account" : undefined} direction="row" spacing={3} sx={{ py: 3, alignItems: "flex-start" }}>
              <Avatar sx={{ bgcolor: "primary.main", color: "primary.contrastText" }}>
                {step.num}
              </Avatar>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography variant="h6" gutterBottom>
                  {step.title}
                </Typography>
                <Typography color="text.secondary">{step.desc}</Typography>
                {step.code && (
                  <Box
                    component="pre"
                    sx={{
                      mt: 2,
                      mb: 0,
                      p: 2,
                      overflowX: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      bgcolor: "background.paper",
                      border: 1,
                      borderColor: "divider",
                      typography: "body2",
                    }}
                  >
                    {step.code}
                  </Box>
                )}
                {step.link && (
                  <Button
                    component={step.link.href.startsWith("http") ? "a" : Link}
                    href={step.link.href}
                    {...(step.link.href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    variant="contained"
                    sx={{ mt: 2 }}
                  >
                    {step.link.label}
                  </Button>
                )}
              </Box>
            </Stack>
          ))}
        </Stack>
      </Container>

      <Container component="section" maxWidth="lg" sx={{ pb: { xs: 6, sm: 8 } }}>
        <Typography variant="h4" component="h2" gutterBottom sx={{ textAlign: "center" }}>
          What you get
        </Typography>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)", md: "repeat(3, 1fr)" },
            gap: 2,
          }}
        >
          {FEATURES.map((feature) => (
            <Card key={feature.title}>
              <CardContent>
                <Typography variant="h3" component="div" sx={{ mb: 1 }} aria-hidden="true">
                  {feature.icon}
                </Typography>
                <Typography variant="h6" gutterBottom>
                  {feature.title}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {feature.desc}
                </Typography>
              </CardContent>
            </Card>
          ))}
        </Box>
      </Container>

      <Box component="footer" sx={{ mt: "auto", borderTop: 1, borderColor: "divider", py: 3 }}>
        <Container maxWidth="lg">
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={2}
            sx={{ alignItems: { xs: "flex-start", sm: "center" }, justifyContent: "space-between" }}
          >
            <Box>
              <Typography variant="overline" color="primary" sx={{ display: "block" }}>
                Sprite Cloud
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Self-hosted game streaming
              </Typography>
            </Box>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", alignItems: "center" }}>
              <Typography variant="caption" color="text.secondary">
                © {new Date().getFullYear()} Sprite Cloud
              </Typography>
              <Typography variant="caption" color="text.disabled">·</Typography>
              <MuiLink href="https://github.com/longjoel/sprite-cloud/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" variant="caption" underline="hover">License</MuiLink>
              <Typography variant="caption" color="text.disabled">·</Typography>
              <MuiLink href="https://github.com/longjoel/sprite-cloud" target="_blank" rel="noopener noreferrer" variant="caption" underline="hover">Source</MuiLink>
              <Typography variant="caption" color="text.disabled">·</Typography>
              <MuiLink href="https://discord.gg/zujXa48kyS" target="_blank" rel="noopener noreferrer" variant="caption" underline="hover">Discord</MuiLink>
            </Stack>
          </Stack>
        </Container>
      </Box>
    </Box>
  );
}
