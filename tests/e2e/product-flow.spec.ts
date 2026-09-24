import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';

test('A-09/A-10: edited example, visible roles, reload approval and exact downloadable result', async ({ page }) => {
  await page.goto('/');
  const input = page.getByLabel('Что должна делать функция?');
  await expect(page.getByRole('button', { name: 'Запустить агентов' })).toBeDisabled();
  for (const title of ['Объединить интервалы', 'Кратчайший путь', 'Котопереводчик']) {
    await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible();
  }
  await page.getByRole('button', { name: /Объединить интервалы/ }).click();
  await expect(input).toHaveValue(/mergeIntervals/);
  expect(new URL(page.url()).hash).toBe('');
  await input.fill((await input.inputValue()) + '\nQA: обязательно проверь касание интервалов.');
  await page.getByRole('button', { name: 'Запустить агентов' }).click();
  await expect(page.getByRole('heading', { name: 'Автор', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ревьюер', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Применяющий агент', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Подтвердить', exact: true })).toBeVisible();
  const taskUrl = page.url();
  const before = await page.getByLabel('Содержимое solution.ts').innerText();
  expect(before).toContain('mergeIntervals');
  await page.reload();
  expect(page.url()).toBe(taskUrl);
  await expect(page.getByRole('button', { name: 'Подтвердить', exact: true })).toBeVisible();
  await expect(page.getByLabel('Содержимое solution.ts')).toHaveText(before);
  await expect(page.getByRole('link', { name: /Скачать комплект ZIP/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Файлы сохранены' })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: /Скачать комплект ZIP/ }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const archive = unzipSync(await readFile(downloadPath!));
  expect(Object.keys(archive).sort()).toEqual(['solution.test.ts', 'solution.ts']);
  expect(Buffer.from(archive['solution.ts']!).toString('utf8')).toBe(before);
});
