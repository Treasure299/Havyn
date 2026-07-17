import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/manrope/latin-400.css";
import "@fontsource/manrope/latin-500.css";
import "@fontsource/manrope/latin-600.css";
import "@fontsource/manrope/latin-700.css";
import "@fontsource/manrope/latin-800.css";
import App from "./App.jsx";
import "./styles.css";

function describeError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack || "" };
  }
  return { name: "Error", message: String(error || "Unknown renderer error"), stack: "" };
}

function recordRendererFailure(event, error, details = {}) {
  window.havyn?.diagnostics?.log?.({
    scope: "renderer-crash",
    event,
    error: describeError(error),
    ...details
  });
}

window.addEventListener("error", (event) => {
  recordRendererFailure("window-error", event.error || event.message, {
    source: event.filename || "",
    line: event.lineno || 0,
    column: event.colno || 0
  });
});

window.addEventListener("unhandledrejection", (event) => {
  recordRendererFailure("unhandled-rejection", event.reason);
});

class RendererBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    recordRendererFailure("react-boundary", error, {
      componentStack: info?.componentStack || ""
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="boot-screen" role="alert">
        <strong>Havyn could not open this room</strong>
        <span>The error was saved to Diagnostics. Restart Havyn to return to your dashboard.</span>
        <button className="primary-button" type="button" onClick={() => window.location.reload()}>
          Restart Havyn
        </button>
      </main>
    );
  }
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <RendererBoundary>
      <App />
    </RendererBoundary>
  </React.StrictMode>
);
