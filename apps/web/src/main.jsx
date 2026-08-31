import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./tokens.css";
import "./globals.css";
import "./styles.css";
import "./RoomShell.module.css";

createRoot(document.getElementById("root")).render(<App />);
