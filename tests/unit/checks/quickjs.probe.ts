import assert from "node:assert/strict";
import ts from "typescript";
import { getQuickJS } from "quickjs-emscripten";

const quickJS = await getQuickJS();

// Компилирует TypeScript и выполняет его в QuickJS с ограничениями ресурсов.
function evaluate(source: string, expression: string, timeoutMs = 100): unknown {
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    reportDiagnostics: true,
  });

  assert.equal(transpiled.diagnostics?.length ?? 0, 0);

  const runtime = quickJS.newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(
    /* Прерывает QuickJS, когда исчерпан допустимый интервал выполнения. */ () =>
      Date.now() > deadline,
  );
  const context = runtime.newContext();
  try {
    const result = context.evalCode(`var exports = {};\n${transpiled.outputText}\n${expression}`);
    if (result.error) {
      const error = context.dump(result.error);
      result.error.dispose();
      throw new Error(JSON.stringify(error));
    }
    const value = context.dump(result.value);
    result.value.dispose();
    return value;
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

assert.equal(
  evaluate(
    "export function add(a: number, b: number): number { return a + b; }",
    "exports.add(2, 3)",
  ),
  5,
);
console.log("PASS TypeScript pure synchronous export: 2 + 3 = 5");

assert.throws(
  /* Запускает бесконечный цикл для проверки прерывания QuickJS. */ () =>
    evaluate("export function loop(): never { while (true) {} }", "exports.loop()", 100),
  /interrupted/i,
);
console.log("PASS infinite loop interrupted in 100 ms deadline");

assert.throws(
  /* Запускает чрезмерное выделение памяти для проверки лимита QuickJS. */ () =>
    evaluate(
      "export function allocate(): unknown { return new Array(100_000_000).fill(1); }",
      "exports.allocate()",
    ),
  /out of memory/i,
);
console.log("PASS allocation stopped by 64 MiB runtime limit");

assert.equal(
  evaluate(
    "export function hasHostIO(): boolean { return typeof process !== 'undefined' || typeof require !== 'undefined' || typeof fetch !== 'undefined'; }",
    "exports.hasHostIO()",
  ),
  false,
);
console.log("PASS process, require, and fetch unavailable without host bindings");

assert.throws(
  /* Пытается прочитать файл хоста для проверки изоляции QuickJS. */ () =>
    evaluate(
      "import { readFileSync } from 'node:fs'; export function read(): string { return readFileSync('/private/tmp/kontur-archive-sentinel.txt', 'utf8'); }",
      "exports.read()",
    ),
  /require.*is not defined/,
);
console.log("PASS node:fs import cannot read a file in QuickJS");
