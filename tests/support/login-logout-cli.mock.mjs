#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Исполняемый mock CLI читает только собственное состояние, личная авторизация не затрагивается.
const directory = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli 0.156.1");
} else if (args[0] === "login" && args[1] === "status") {
  const loggedIn = readFileSync(join(directory, "auth-state"), "utf8") === "logged-in";
  console.error(loggedIn ? "Logged in using ChatGPT" : "Not logged in");
  process.exitCode = loggedIn ? 0 : 1;
} else if (args[0] === "exec") {
  const schema = JSON.parse(readFileSync(args[args.indexOf("--output-schema") + 1], "utf8"));
  const kind = schema.properties.kind.const;
  appendFileSync(join(directory, "calls.jsonl"), JSON.stringify({ kind }) + "\n");
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    prompt += chunk;
  });
  process.stdin.on("end", () => {
    if (kind === "review" && existsSync(join(directory, "review-auth-once"))) {
      console.log(JSON.stringify({ type: "turn.started" }));
      // Тест выходит из Codex только после сохранения версии и запуска процесса ревьюера.
      const timer = setInterval(() => {
        if (readFileSync(join(directory, "auth-state"), "utf8") !== "logged-out") return;
        clearInterval(timer);
        unlinkSync(join(directory, "review-auth-once"));
        console.log(JSON.stringify({ type: "error", message: "401 Unauthorized" }));
      }, 25);
      return;
    }
    const approval = kind === "apply_request" ? JSON.parse(prompt).approval : null;
    const output =
      kind === "candidate"
        ? {
            kind: "candidate",
            functionName: "identity",
            solutionTs: "export function identity(value: number): number { return value; }",
            cases: [{ name: "positive", args: [7], expected: 7 }],
          }
        : kind === "review"
          ? { kind: "review", verdict: "approved", findings: [] }
          : {
              kind: "apply_request",
              versionId: approval.versionId,
              manifestHash: approval.manifestHash,
            };
    for (const event of [
      { type: "turn.started" },
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(output) } },
      { type: "turn.completed" },
    ])
      console.log(JSON.stringify(event));
  });
} else {
  throw new Error("Unexpected mock CLI command");
}
