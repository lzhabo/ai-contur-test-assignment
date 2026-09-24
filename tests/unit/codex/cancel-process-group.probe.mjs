import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

const child = spawn(process.execPath, ["-e", `
  const { spawn } = require('node:child_process');
  const grandchild = spawn('sleep', ['60'], { stdio: 'ignore' });
  console.log(grandchild.pid);
  setInterval(() => {}, 1000);
`], { detached: true, stdio: ["ignore", "pipe", "pipe"] });

const grandchildPid = await new Promise((resolve, reject) => {
  let line = "";
  const timeout = setTimeout(() => reject(new Error("child did not report grandchild PID")), 3000);
  child.stdout.on("data", (chunk) => {
    line += chunk.toString();
    if (line.includes("\n")) {
      clearTimeout(timeout);
      resolve(Number(line.trim()));
    }
  });
  child.once("error", reject);
});

assert.ok(child.pid > 0 && grandchildPid > 0);
process.kill(-child.pid, "SIGTERM");
await new Promise((resolve) => child.once("exit", resolve));
await new Promise((resolve) => setTimeout(resolve, 100));

const status = spawnSync("ps", ["-o", "stat=", "-p", String(grandchildPid)], { encoding: "utf8" });
assert.ok(status.status !== 0 || /^Z/.test(status.stdout.trim()), `grandchild still running: ${status.stdout}`);
console.log("PASS detached process group SIGTERM stopped parent and sleep grandchild");
