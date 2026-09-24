import { isDeepStrictEqual } from "node:util";
import { parentPort, workerData } from "node:worker_threads";
import { realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { getQuickJS } from "quickjs-emscripten";

interface Case { name: string; args: unknown[]; expected: unknown }
interface Input { solutionTs: string; functionName: string; cases: Case[]; deadline: number; memoryLimitBytes: number }
interface Result { compilation: { status: "passed" | "failed"; details: string[] }; tests: { status: "passed" | "failed" | "timeout" | "error"; details: string[] }; passedCases: number; failedCases: number }
const input = workerData as Input;

function diagnostics(source: string, functionName: string): string[] {
  const fileName = "/virtual/solution.ts";
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  if (file.referencedFiles.length || file.typeReferenceDirectives.length || file.libReferenceDirectives.length) {
    return ["Reference directives are forbidden"];
  }
  let nestedImport = false;
  function inspect(node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.ImportType || node.kind === ts.SyntaxKind.ImportKeyword) nestedImport = true;
    ts.forEachChild(node, inspect);
  }
  inspect(file);
  if (nestedImport) return ["Dynamic and type imports are forbidden"];
  const declarations = file.statements.filter(ts.isFunctionDeclaration);
  if (declarations.length !== file.statements.length) return ["Only top-level function declarations are allowed; imports and side effects are forbidden"];
  if (!declarations.some((statement) => statement.name?.text === functionName && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))) {
    return [`Expected exported function ${functionName}`];
  }
  if (declarations.some((statement) => statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) || !!statement.asteriskToken)) {
    return ["Async and generator functions are not supported"];
  }
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true, noEmit: true, noResolve: true, types: [], lib: ["lib.es2022.d.ts"], skipLibCheck: true };
  const host = ts.createCompilerHost(options);
  const libRoot = realpathSync(path.dirname(ts.getDefaultLibFilePath(options)));
  const allowed = (name: string) => {
    try {
      const full = realpathSync(name);
      return full.startsWith(libRoot + path.sep) && /^lib\.[a-z0-9.]+\.d\.ts$/.test(path.basename(full));
    } catch { return false; }
  };
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => name === fileName ? file : allowed(name) ? originalGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile) : undefined;
  host.fileExists = ((original) => (name: string) => name === fileName || (allowed(name) && original(name)))(host.fileExists.bind(host));
  host.readFile = ((original) => (name: string) => name === fileName ? source : allowed(name) ? original(name) : undefined)(host.readFile.bind(host));
  const program = ts.createProgram([fileName], options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).slice(0, 30);
}

async function run(): Promise<Result> {
  const errors = diagnostics(input.solutionTs, input.functionName);
  if (errors.length) return { compilation: { status: "failed", details: errors }, tests: { status: "failed", details: ["Compilation failed"] }, passedCases: 0, failedCases: input.cases.length };
  const emitted = ts.transpileModule(input.solutionTs, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const quickJS = await getQuickJS();
  let passedCases = 0;
  let failedCases = 0;
  const details: string[] = [];
  let testStatus: Result["tests"]["status"] = "passed";
  for (const testCase of input.cases) {
    if (Date.now() >= input.deadline) { testStatus = "timeout"; details.push("Check deadline exceeded"); break; }
    const runtime = quickJS.newRuntime();
    runtime.setMemoryLimit(input.memoryLimitBytes);
    runtime.setMaxStackSize(Math.min(1024 * 1024, Math.floor(input.memoryLimitBytes / 8)));
    runtime.setInterruptHandler(() => Date.now() >= input.deadline);
    const context = runtime.newContext();
    try {
      const script = `var exports = {};\n${emitted}\nvar __args = ${JSON.stringify(testCase.args)}; var __before = JSON.stringify(__args); var __result = exports[${JSON.stringify(input.functionName)}](...__args); if (JSON.stringify(__args) !== __before) throw new Error('input mutated'); JSON.stringify(__result, function (_key, value) { if ((typeof value === 'number' && !Number.isFinite(value)) || ['undefined', 'function', 'symbol', 'bigint'].includes(typeof value)) throw new Error('non-JSON result'); return value; });`;
      const result = context.evalCode(script);
      if (result.error) {
        const error = context.dump(result.error) as { name?: string; message?: string };
        result.error.dispose();
        failedCases++;
        if (Date.now() >= input.deadline || /interrupted/i.test(error.message ?? "")) testStatus = "timeout";
        else testStatus = "failed";
        details.push(`${testCase.name}: ${error.name ?? "Error"}: ${error.message ?? "unknown"}`);
      } else {
        const text = context.dump(result.value);
        result.value.dispose();
        if (typeof text !== "string" || Buffer.byteLength(text) > 64 * 1024) {
          failedCases++;
          testStatus = "failed";
          details.push(`${testCase.name}: result is not bounded JSON`);
        } else {
          try {
            const actual = JSON.parse(text) as unknown;
            if (isDeepStrictEqual(actual, testCase.expected)) passedCases++;
            else { failedCases++; testStatus = "failed"; details.push(`${testCase.name}: expected ${JSON.stringify(testCase.expected)}, got ${text}`); }
          } catch { failedCases++; testStatus = "failed"; details.push(`${testCase.name}: invalid JSON result`); }
        }
      }
    } finally { context.dispose(); runtime.dispose(); }
    if (testStatus === "timeout") break;
  }
  return { compilation: { status: "passed", details: [] }, tests: { status: testStatus, details: details.slice(0, 30) }, passedCases, failedCases: failedCases + (testStatus === "timeout" ? input.cases.length - passedCases - failedCases : 0) };
}

run().then((result) => parentPort?.postMessage(result)).catch((error) => parentPort?.postMessage({ fatal: String(error) }));
