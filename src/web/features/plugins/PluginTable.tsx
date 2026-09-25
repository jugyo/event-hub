import {
  Alert,
  Box,
  Chip,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import type { PluginDto } from "../../api/client.ts";

function time(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "未実行";
}

export function PluginTable({ title, plugins }: { title: string; plugins: PluginDto[] }) {
  return (
    <section aria-labelledby={`${title}-heading`}>
      <Typography id={`${title}-heading`} component="h2" variant="h5" sx={{ mb: 2 }}>
        {title}
      </Typography>
      {plugins.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 3 }}>
          <Typography>登録済みの {title} はありません。</Typography>
        </Paper>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table aria-label={`${title} の稼働状況`} sx={{ minWidth: 720 }}>
            <TableHead>
              <TableRow>
                <TableCell>Plugin</TableCell>
                <TableCell>Load state</TableCell>
                <TableCell>最終実行</TableCell>
                <TableCell>結果</TableCell>
                <TableCell align="right">Pending work</TableCell>
                <TableCell>Failure / diagnostics</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {plugins.map((plugin) => (
                <TableRow key={plugin.id}>
                  <TableCell component="th" scope="row">
                    <strong>{plugin.id}</strong>
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={plugin.loadState}
                      color={plugin.loadState === "loaded" ? "success" : "error"}
                    />
                  </TableCell>
                  <TableCell>
                    <time dateTime={plugin.lastRun?.startedAt}>{time(plugin.lastRun?.startedAt)}</time>
                  </TableCell>
                  <TableCell>{plugin.lastRun?.status ?? "—"}</TableCell>
                  <TableCell align="right">{plugin.pendingWork}</TableCell>
                  <TableCell>
                    <Stack spacing={1}>
                      {plugin.failure && (
                        <Alert severity="error">
                          {plugin.failure.code}: {plugin.failure.message}
                        </Alert>
                      )}
                      {plugin.diagnostics.map((item) => (
                        <Alert severity="warning" key={`${item.code}-${item.occurredAt}`}>
                          {item.code}: {item.message}
                        </Alert>
                      ))}
                      {!plugin.failure && plugin.diagnostics.length === 0 && <Box component="span">なし</Box>}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </section>
  );
}
