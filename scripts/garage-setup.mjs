import { randomBytes } from "node:crypto";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const envPath = new URL(".env", root);
let contents = await readFile(envPath, "utf8").catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
});
const values = parseEnv(contents);
const defaults = {
  GARAGE_RPC_SECRET: randomBytes(32).toString("hex"),
  GARAGE_ACCESS_KEY_ID: `GK${randomBytes(12).toString("hex")}`,
  GARAGE_SECRET_ACCESS_KEY: randomBytes(32).toString("hex"),
  GARAGE_BUCKET: "beatrice-media",
  GARAGE_ENDPOINT: "http://127.0.0.1:3900",
};
for (const [key, value] of Object.entries(defaults)) {
  if (values[key]) continue;
  const assignment = new RegExp(`^(?:export\\s+)?${key}=.*$`, "m");
  contents = assignment.test(contents)
    ? contents.replace(assignment, `${key}=${value}`)
    : `${contents.trimEnd()}\n${key}=${value}\n`;
}
await writeFile(envPath, contents, { mode: 0o600 });
await chmod(envPath, 0o600);
console.log("Garage configuration saved to .env (existing values preserved).");
const result = spawnSync(
  "docker",
  ["compose", "up", "-d", "--wait", "garage"],
  {
    cwd: root,
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
