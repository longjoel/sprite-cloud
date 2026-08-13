import type { ReactNode } from "react";
import { Box, Container, Divider, Stack, Typography } from "@mui/material";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { verifyBearerToken } from "@/lib/server-auth";
import AppHeader from "@/components/fluent/AppHeader";
import LegalFooter from "@/components/LegalFooter";

export async function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  const session = await auth();
  const requestHeaders = await headers();
  const lanServer = requestHeaders.get("x-sc-server-lan") === "1"
    ? await verifyBearerToken(requestHeaders.get("authorization"))
    : null;

  return (
    <Box component="main" sx={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <AppHeader
        userName={session?.user?.name || session?.user?.email}
        authenticated={Boolean(session?.user?.id)}
        isLanProxy={lanServer !== null}
      />
      <Container maxWidth="md" sx={{ py: { xs: 5, sm: 8 }, flex: 1 }}>
        <Typography component="h1" variant="h3" gutterBottom>{title}</Typography>
        <Typography color="text.secondary">Last updated: {updated}</Typography>
        <Divider sx={{ my: 3 }} />
        <Stack spacing={3} sx={{ "& h2": { mt: 2 } }}>{children}</Stack>
      </Container>
      <LegalFooter />
    </Box>
  );
}
