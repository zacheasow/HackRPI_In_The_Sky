import dotenv from "dotenv";
import { initTelemetry, status } from "../server/tiger.js";

dotenv.config();
await initTelemetry();
console.log(status().mode);
