import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Container,
  CssBaseline,
  Grid,
  Stack,
  ThemeProvider,
  Typography,
  createTheme,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { dashboardQuery } from "../features/plugins/query.ts";
import { PluginTable } from "../features/plugins/PluginTable.tsx";

const theme = createTheme({
  palette: { mode: "light", primary: { main: "#165d72" }, background: { default: "#f3f6f7" } },
  typography: { fontFamily: "Inter, system-ui, sans-serif" },
});

export function App() {
  const query = useQuery(dashboardQuery);
  if (query.isPending)
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Box
          role="status"
          aria-label="稼働状況を読み込み中"
          sx={{ display: "grid", minHeight: "100vh", placeItems: "center" }}
        >
          <CircularProgress />
        </Box>
      </ThemeProvider>
    );
  if (query.isError && !query.data)
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Container component="main" sx={{ py: 8 }}>
          <Alert
            severity="error"
            action={
              <Button color="inherit" onClick={() => void query.refetch()}>
                再試行
              </Button>
            }
          >
            稼働状況を取得できませんでした。
          </Alert>
        </Container>
      </ThemeProvider>
    );

  const data = query.data!;
  const cards = [
    ["Source", data.summary.sources],
    ["Consumer", data.summary.consumers],
    ["異常", data.summary.unhealthy],
    ["Pending work", data.summary.pendingWork],
  ] as const;
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box component="header" sx={{ bgcolor: "#152238", color: "white", py: { xs: 3, md: 5 } }}>
        <Container>
          <Typography component="p" sx={{ opacity: 0.75 }}>
            event-hub v{data.project.version}
          </Typography>
          <Typography component="h1" variant="h3" sx={{ fontWeight: 700, overflowWrap: "anywhere" }}>
            {data.project.name}
          </Typography>
          <Typography>
            稼働開始 <time dateTime={data.project.startedAt}>{new Date(data.project.startedAt).toLocaleString()}</time>
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
                  再試行
                </Button>
              }
            >
              更新に失敗しました。直近のデータを表示しています。
            </Alert>
          )}
          {query.isFetching && !query.isPending && (
            <Typography role="status" aria-live="polite">
              更新中…
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
            最終更新 <time dateTime={data.updatedAt}>{new Date(data.updatedAt).toLocaleString()}</time>（UTC:{" "}
            {data.updatedAt}）
          </Typography>
          <PluginTable title="Sources" plugins={data.plugins.filter((plugin) => plugin.kind === "source")} />
          <PluginTable title="Consumers" plugins={data.plugins.filter((plugin) => plugin.kind === "consumer")} />
        </Stack>
      </Container>
    </ThemeProvider>
  );
}
