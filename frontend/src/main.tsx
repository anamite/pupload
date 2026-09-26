import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { registerServiceWorker } from "./lib/pwa";
import { applyTheme, savedTheme } from "./lib/theme";
import "./index.css";

applyTheme(savedTheme() ?? "system", false);
registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
