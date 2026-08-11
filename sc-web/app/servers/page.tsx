import { redirect } from "next/navigation";
import { Box, Container, Paper, Stack, Typography } from "@mui/material";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { serverMembers, servers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import AppHeader from "@/components/fluent/AppHeader";
import DashboardClient from "@/app/servers/DashboardClient";
import PairingPrompt from "@/app/servers/PairingPrompt";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/api/auth/signin");

  const memberships = await db
    .select({
      id: servers.id,
      name: servers.name,
      lastSeenAt: servers.lastSeenAt,
      role: serverMembers.role,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(eq(serverMembers.userId, session.user.id));

  return (
    <Box component="main" sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
      <AppHeader
        userName={session.user?.name || session.user?.email || undefined}
        authenticated
      />

      <Container maxWidth="lg" sx={{ py: 3 }}>
        <Stack spacing={1.5} sx={{ mb: 4 }}>
          <Typography
            variant="overline"
            color="text.secondary"
            sx={{ letterSpacing: "0.08em" }}
          >
            Dashboard
          </Typography>
          <Typography component="h1" variant="h3">
            Your servers
          </Typography>
          <Typography color="text.secondary" sx={{ maxWidth: 720, lineHeight: 1.6 }}>
            Access the sc-server instances shared with you. Administrators can
            pair, rename, invite members, inspect, and remove servers here.
          </Typography>
        </Stack>

        {memberships.length === 0 ? (
          <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
            <Stack spacing={2}>
              <Typography color="text.secondary">
                No servers yet. Pair a sc-server or ask an administrator for an
                invitation.
              </Typography>
              <PairingPrompt />
            </Stack>
          </Paper>
        ) : (
          <DashboardClient
            memberships={memberships.map((srv) => ({
              id: srv.id,
              name: srv.name || srv.id.slice(0, 8),
              lastSeenAt: srv.lastSeenAt?.toISOString() ?? null,
              role: srv.role,
            }))}
          />
        )}
      </Container>
    </Box>
  );
}
