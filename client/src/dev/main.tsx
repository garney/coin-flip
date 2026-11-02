import React from "react";
import ReactDOM from "react-dom/client";
import { CoinLab } from "./CoinLab";
import "../styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {import.meta.env.DEV ? <CoinLab /> : <p>Not available.</p>}
  </React.StrictMode>
);
