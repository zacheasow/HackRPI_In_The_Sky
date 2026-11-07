import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/vendor/animejs", express.static(path.join(__dirname, "..", "node_modules", "animejs", "dist")));

app.listen(port, () => {
  console.log(`In the Clouds listening on http://localhost:${port}`);
});
