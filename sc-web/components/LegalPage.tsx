import type { ReactNode } from "react";
import { Box, Container, Divider, Stack, Typography } from "@mui/material";
import LegalFooter from "@/components/LegalFooter";

export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <Box component="main" sx={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
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
