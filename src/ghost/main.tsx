import React from "react";
import ReactDOM from "react-dom/client";
import { GhostPreview } from "./GhostPreview";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <GhostPreview />
  </React.StrictMode>,
);
