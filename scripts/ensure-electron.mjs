import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
accessSync(electronPath, constants.X_OK);
process.stdout.write(`Electron: ${electronPath}\n`);
