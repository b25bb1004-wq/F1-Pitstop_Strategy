import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  addEventListener("load", () => navigator.serviceWorker.register(import.meta.env.BASE_URL + "sw.js").catch(() => {}));
}
