import { CssBaseline, ThemeProvider } from "@mui/material";
import { BrowserRouter, Route, Routes } from "react-router";
import { DashboardPage } from "./DashboardPage.tsx";
import { SourceDetailPage } from "./SourceDetailPage.tsx";
import { theme } from "./theme.ts";

export function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/sources/:sourceId" element={<SourceDetailPage />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}
