import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { Alert, Box, Typography } from "@mui/material";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(users);
  if (Number(row?.count ?? 0) > 0) redirect("/signin");

  return (
    <Box sx={{ maxWidth: 560, mx: "auto", mt: 8, px: 2 }}>
      <Typography variant="h4" sx={{ mb: 2 }}>First-run setup</Typography>
      <Alert severity="info">
        Enrollment requires the private bootstrap invitation printed in the protected server logs. Open that invitation link to create the first account.
      </Alert>
    </Box>
  );
}
