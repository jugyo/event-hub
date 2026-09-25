import { Alert, Box, Button, Chip, CircularProgress, Container, Link, Paper, Stack, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link as RouterLink, useParams } from "react-router";
import type { Notice, PluginDetailDto } from "../api/client.ts";
import { EventTable } from "../features/events/EventTable.tsx";
import { pluginQuery } from "../features/plugins/query.ts";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Typography component="dt" color="text.secondary">
        {label}
      </Typography>
      <Typography component="dd" sx={{ m: 0 }}>
        {children}
      </Typography>
    </Box>
  );
}

function Timestamp({ value }: { value: string | null }) {
  if (!value) return <>—</>;
  return (
    <>
      <time dateTime={value}>{new Date(value).toLocaleString()}</time>
      <Typography component="span" color="text.secondary" sx={{ display: "block" }}>
        UTC: {value}
      </Typography>
    </>
  );
}

function Notices({ failure, diagnostics }: { failure: Notice | null; diagnostics: Notice[] }) {
  if (!failure && diagnostics.length === 0) return <>None</>;
  return (
    <Stack spacing={1}>
      {failure && (
        <Alert severity="error">
          {failure.code}: {failure.message}
        </Alert>
      )}
      {diagnostics.map((item) => (
        <Alert severity="warning" key={`${item.code}-${item.occurredAt}`}>
          {item.code}: {item.message}
        </Alert>
      ))}
    </Stack>
  );
}

function SourceSummary({ plugin }: { plugin: PluginDetailDto }) {
  return (
    <Paper
      component="dl"
      variant="outlined"
      sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" }, m: 0, p: 3 }}
    >
      <Field label="Load state">
        <Chip size="small" label={plugin.loadState} color={plugin.loadState === "loaded" ? "success" : "error"} />
      </Field>
      <Field label="Result">{plugin.lastRun?.status ?? "Not run"}</Field>
      <Field label="Last run started">
        <Timestamp value={plugin.lastRun?.startedAt ?? null} />
      </Field>
      <Field label="Last run finished">
        <Timestamp value={plugin.lastRun?.finishedAt ?? null} />
      </Field>
      <Field label="Pending work">
        {plugin.pendingWork} (pending {plugin.pendingWorkBreakdown.pending} / retry_wait{" "}
        {plugin.pendingWorkBreakdown.retry_wait})
      </Field>
      <Field label="Failure / diagnostics">
        <Notices failure={plugin.failure} diagnostics={plugin.diagnostics} />
      </Field>
    </Paper>
  );
}

export function SourceDetailPage() {
  const { sourceId = "" } = useParams();
  const query = useQuery(pluginQuery(sourceId));
  const refetch = () => void query.refetch();
  return (
    <>
      <Box component="header" sx={{ bgcolor: "#152238", color: "white", py: { xs: 3, md: 5 } }}>
        <Container>
          <Link component={RouterLink} to="/" color="inherit">
            ← Dashboard
          </Link>
          <Typography component="h1" variant="h3" sx={{ fontWeight: 700, overflowWrap: "anywhere" }}>
            {sourceId}
          </Typography>
          <Typography sx={{ opacity: 0.75 }}>Source</Typography>
        </Container>
      </Box>
      <Container component="main" sx={{ py: 4 }}>
        <Stack spacing={4}>
          <section aria-labelledby="source-heading">
            <Typography id="source-heading" component="h2" variant="h5" sx={{ mb: 2 }}>
              Status
            </Typography>
            <Stack spacing={2}>
              {query.isError && (
                <Alert
                  severity={query.data ? "warning" : "error"}
                  action={
                    <Button color="inherit" onClick={refetch}>
                      Retry
                    </Button>
                  }
                >
                  {query.data
                    ? "The update failed. Showing the most recent data."
                    : "Source status could not be loaded."}
                </Alert>
              )}
              {query.isFetching && !query.isPending && (
                <Typography role="status" aria-live="polite">
                  Updating…
                </Typography>
              )}
              {query.isPending ? (
                <Box
                  role="status"
                  aria-label="Loading source status"
                  sx={{ display: "grid", placeItems: "center", py: 6 }}
                >
                  <CircularProgress />
                </Box>
              ) : (
                query.data && <SourceSummary plugin={query.data} />
              )}
            </Stack>
          </section>
          <EventTable sourceId={sourceId} />
        </Stack>
      </Container>
    </>
  );
}
