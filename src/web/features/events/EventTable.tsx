import {
  Alert,
  Button,
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
import { useQuery } from "@tanstack/react-query";
import { eventsQuery } from "./query.ts";

/** Recent stored events for one source. Never polled, so the user's position stays stable while browsing. */
export function EventTable({ sourceId }: { sourceId: string }) {
  const query = useQuery(eventsQuery(sourceId));
  const refetch = () => void query.refetch();
  return (
    <section aria-labelledby="events-heading">
      <Typography id="events-heading" component="h2" variant="h5" sx={{ mb: 2 }}>
        Recent events
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
            {query.data ? "The update failed. Showing the most recent data." : "Events could not be loaded."}
          </Alert>
        )}
        {query.isPending ? (
          <Paper variant="outlined" role="status" aria-label="Loading events" sx={{ p: 3 }}>
            <Typography>Loading…</Typography>
          </Paper>
        ) : query.data && query.data.events.length === 0 ? (
          <Paper variant="outlined" sx={{ p: 3 }}>
            <Typography>No events are stored for this source.</Typography>
          </Paper>
        ) : (
          query.data && (
            <TableContainer component={Paper} variant="outlined">
              <Table aria-label="Recent events" sx={{ minWidth: 640 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>occurredAt</TableCell>
                    <TableCell>type</TableCell>
                    <TableCell>id</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {query.data.events.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell>
                        <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time>
                        <Typography component="span" color="text.secondary" sx={{ display: "block" }}>
                          UTC: {event.occurredAt}
                        </Typography>
                      </TableCell>
                      <TableCell>{event.type}</TableCell>
                      <TableCell component="th" scope="row">
                        {event.id}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )
        )}
      </Stack>
    </section>
  );
}
