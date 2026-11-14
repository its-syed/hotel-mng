import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { PublicBooking } from "./PublicBooking.jsx";
import "./styles.css";
import "./restin-theme.css";
createRoot(document.getElementById("root")).render(<React.StrictMode>{window.location.pathname==="/book"||window.location.pathname==="/website"?<PublicBooking/>:<App/>}</React.StrictMode>);