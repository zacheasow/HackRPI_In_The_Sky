import dotenv from "dotenv";
import { createApp } from "./app.js";
import { initTelemetry } from "./tiger.js";

dotenv.config();

const port = Number(process.env.PORT) || 3000;
const app = createApp();
app.set("trust proxy", 1);
app.listen(port, () => {
  console.log(`Aerogami listening on http://localhost:${port}`);
});
initTelemetry();
