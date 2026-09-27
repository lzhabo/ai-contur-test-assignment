import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

const child = spawn(
  process.execPath,
  [
    "-e",
    `
  const { spawn } = require('node:child_process');
  const grandchild = spawn('sleep', ['60'], { stdio: 'ignore' });
  console.log(grandchild.pid);
  setInterval(() => {}, 1000);
`,
  ],
  { detached: true, stdio: ["ignore", "pipe", "pipe"] },
);

const grandchildPid = await new Promise((resolve, reject) => {
  // Отклоняет ожидание при отсутствии ответа до установленного срока.

  let line = "";
  const timeout = setTimeout(
    /* Прерывает ожидание при превышении отведённого срока. */ () =>
      reject(new Error("child did not report grandchild PID")),
    3000,
  );
  child.stdout.on("data", (chunk) => {
    // Обрабатывает сигнал процесса и завершает соответствующее ожидание.

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
await new Promise(
  /* Дожидается выхода дочернего процесса и сохраняет код завершения. */ (resolve) =>
    child.once("exit", resolve),
);
await new Promise(
  /* Выдерживает короткий интервал перед повторной проверкой состояния. */ (resolve) =>
    setTimeout(resolve, 100),
);

const status = spawnSync("ps", ["-o", "stat=", "-p", String(grandchildPid)], {
  encoding: "utf8",
});
assert.ok(
  status.status !== 0 || /^Z/.test(status.stdout.trim()),
  `grandchild still running: ${status.stdout}`,
);
console.log("PASS detached process group SIGTERM stopped parent and sleep grandchild");
