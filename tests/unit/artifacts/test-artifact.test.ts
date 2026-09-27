import { expect, it } from "vitest";
import {
  parseTestArtifact,
  renderTestArtifact,
} from "../../../src/server/storage/test-artifact.js";

const cases = [{ name: "число сохраняется", args: [7], expected: 7 }];

// Проверяет чтение собственных метаданных без выполнения сохранённого TypeScript.
it("формат тестового файла сохраняет имя функции и вложенные JSON-случаи", () => {
  const nestedCases = [
    {
      name: "вложенный объект",
      args: [{ values: [1, null, true] }],
      expected: { values: [1, null, true] },
    },
  ];

  const source = renderTestArtifact("identity", nestedCases);
  const decoded = parseTestArtifact(source);

  expect(decoded).toEqual({ functionName: "identity", cases: nestedCases });
  expect(source).toContain('import test from "node:test"');
});

// Проверяет, что доверенное начало файла не разрешает менять остальной исполняемый код.
it.each([
  {
    label: "экспорт функции",
    original: 'export const functionName = "identity";',
    replacement: 'export const functionName = "other";',
  },
  {
    label: "ожидаемый результат",
    original: '"expected": 7',
    replacement: '"expected": 0',
  },
  {
    label: "тело проверки",
    original: "assert.deepStrictEqual(actual, testCase.expected);",
    replacement: "assert.ok(true);",
  },
])("формат тестового файла отклоняет подмену: $label", ({ original, replacement }) => {
  const source = renderTestArtifact("identity", cases);

  expect(source).toContain(original);

  const tampered = source.replace(original, replacement);

  const readTampered = /* Пытается прочитать изменённый файл через доверенный декодер. */ () =>
    parseTestArtifact(tampered);

  expect(readTampered).toThrow("Invalid trusted test artifact");
});

// Подмена одних метаданных не должна изменять случаи, выполняемые исходным телом файла.
it("формат тестового файла отклоняет расхождение метаданных и тела", () => {
  const source = renderTestArtifact("identity", cases);
  const metadata = Buffer.from(JSON.stringify({ functionName: "other", cases })).toString("base64");
  const tampered = source.replace(/^\/\/ Test cases: .+/, `// Test cases: ${metadata}`);

  const readTampered = /* Пытается прочитать изменённый файл через доверенный декодер. */ () =>
    parseTestArtifact(tampered);

  expect(readTampered).toThrow("Invalid trusted test artifact");
});
