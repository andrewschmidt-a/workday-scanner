export async function evaluatePage(page, evaluator) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.evaluate(evaluator);
    } catch (error) {
      if (!/execution context was destroyed|cannot find context with specified id/i.test(error.message) ||
          page.isClosed()) {
        throw error;
      }
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
    }
  }
  throw new Error('The page kept navigating while being read. No application snapshot was saved.');
}
