import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import AuthGate from "./AuthGate";
import DesktopWindow from "./DesktopWindow";
import "./app.css";
import "./desktop-shell.css";
import "./icon-theme.css";

const rootElement = document.querySelector<HTMLElement>("#root");

if (rootElement === null) {
  throw new Error("QA Hub root element is missing.");
}

createRoot(rootElement).render(
  <StrictMode>
    <DesktopWindow>
      <AuthGate />
    </DesktopWindow>
  </StrictMode>,
);
