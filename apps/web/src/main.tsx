import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import AuthGate from "./AuthGate";
import "./app.css";

const rootElement = document.querySelector<HTMLElement>("#root");

if (rootElement === null) {
  throw new Error("QA Hub root element is missing.");
}

createRoot(rootElement).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
);
