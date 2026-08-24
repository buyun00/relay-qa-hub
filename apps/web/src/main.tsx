import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import App from "./App";
import "./app.css";
import { publishPwaStatus } from "./pwa-events";

const rootElement = document.querySelector<HTMLElement>("#root");

if (rootElement === null) {
  throw new Error("QA Hub root element is missing.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

let applyPwaUpdate: (reloadPage?: boolean) => Promise<void> = async () => undefined;

applyPwaUpdate = registerSW({
  immediate: true,
  onOfflineReady() {
    publishPwaStatus({ kind: "offline-ready" });
  },
  onNeedRefresh() {
    publishPwaStatus({
      kind: "update",
      apply: () => {
        void applyPwaUpdate(true);
      },
    });
  },
  onRegisterError() {
    publishPwaStatus({ kind: "registration-error" });
  },
});
