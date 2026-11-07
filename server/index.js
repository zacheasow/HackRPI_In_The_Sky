import dotenv from "dotenv";
import { createApp } from "./app.js";

dotenv.config();

const port = Number(process.env.PORT) || 3000;
createApp().listen(port, () => {
  console.log(`In the Clouds listening on http://localhost:${port}`);
});
