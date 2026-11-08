import dotenv from "dotenv";
import { createApp } from "./app.js";

dotenv.config();

const port = Number(process.env.PORT) || 3000;
const app = createApp();
app.set("trust proxy", 1);
app.listen(port, () => {
  console.log(`In the Clouds listening on http://localhost:${port}`);
});
