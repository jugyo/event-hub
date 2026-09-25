import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Container,
  Grid,
  Stack,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { dashboardQuery } from "../features/plugins/query.ts";
import { PluginTable } from "../features/plugins/PluginTable.tsx";

export function DashboardPage() {
  const query = useQuery(dashboardQuery);
  if (query.isPending)
    return (
      <Box role="status" aria-label="Loading status" sx={{ display: "grid", minHeight: "100vh", placeItems: "center" }}>
        <CircularProgress />
      </Box>
    );
  if (query.isError && !query.data)
    return (
      <Container component="main" sx={{ py: 8 }}>
        <Alert
          severity="error"
          action={
            <Button color="inherit" onClick={() => void query.refetch()}>
              Retry
            </Button>
          }
        >
          Status could not be loaded.
        </Alert>
      </Container>
    );

  const data = query.data!;
  const cards = [
    ["Source", data.summary.sources],
    ["Consumer", data.summary.consumers],
    ["Unhealthy", data.summary.unhealthy],
    ["Pending work", data.summary.pendingWork],
  ] as const;
  return (
    <>
      <Box component="header" sx={{ bgcolor: "#152238", color: "white", py: { xs: 3, md: 5 } }}>
        <Container>
          <Typography component="p" sx={{ opacity: 0.75 }}>
            event-hub v{data.project.version}
          </Typography>
          <Typography component="h1" variant="h3" sx={{ fontWeight: 700, overflowWrap: "anywhere" }}>
            {data.project.name}
          </Typography>
          <Typography>
            Started <time dateTime={data.project.startedAt}>{new Date(data.project.startedAt).toLocaleString()}</time>
          </Typography>
        </Container>
      </Box>
      <Container component="main" sx={{ py: 4 }}>
        <Stack spacing={4}>
          {query.isError && (
            <Alert
              severity="warning"
              action={
                <Button color="inherit" onClick={() => void query.refetch()}>
                  Retry
                </Button>
              }
            >
              The update failed. Showing the most recent data.
            </Alert>
          )}
          {query.isFetching && !query.isPending && (
            <Typography role="status" aria-live="polite">
              Updating…
            </Typography>
          )}
          <Grid container spacing={2}>
            {cards.map(([label, value]) => (
              <Grid key={label} size={{ xs: 6, md: 3 }}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography color="text.secondary">{label}</Typography>
                    <Typography variant="h4" component="p">
                      {value}
                    </Typography>
                  </CardContent>
                </Card>
              </Grid>
            ))}
          </Grid>
          <Typography color="text.secondary">
            Last updated <time dateTime={data.updatedAt}>{new Date(data.updatedAt).toLocaleString()}</time> (UTC:{" "}
            {data.updatedAt})
          </Typography>
          <PluginTable title="Sources" plugins={data.plugins.filter((plugin) => plugin.kind === "source")} />
          <PluginTable title="Consumers" plugins={data.plugins.filter((plugin) => plugin.kind === "consumer")} />
        </Stack>
      </Container>
    </>
  );
}
