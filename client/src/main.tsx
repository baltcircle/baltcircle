import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installNavDebug } from "./nav-debug";

installNavDebug();

createRoot(document.getElementById("root")!).render(<App />);
