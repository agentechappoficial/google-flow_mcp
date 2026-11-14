import fs from 'fs';
import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { launchChromeDirect, isBrowserConnected } from './connect.js';
import { getDefaultChromePath } from '../utils/platform.js';

export async function launchKiaraProfile(headless = false) {
  if (isBrowserConnected()) {
    logger.info('Browser already connected, reusing');
    return { success: true, message: 'Already connected' };
  }

  const cdpPort = get('cdpPort', 9222);
  const chromePath = get('chromeExecutable') || getDefaultChromePath();
  if (!chromePath || !fs.existsSync(chromePath)) {
    throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR,
      `Chrome not found${chromePath ? ` at ${chromePath}` : ''}. Set "chromeExecutable" in config/flow.config.json to your Chrome install path.`);
  }

  logger.info('Launching Chrome with a dedicated Flow profile', { chromePath });

  return await launchChromeDirect({
    chromePath,
    cdpPort,
    headless,
  });
}

export async function navigateToFlow(page, toolPage) {
  const flowUrl = get('flowUrl', 'https://flow.google.com/');
  const targetUrl = toolPage === true
    ? 'https://flow.google.com/'
    : flowUrl;

  logger.info('Navigating to Google Flow', { url: targetUrl });
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Wait for app shell instead of networkidle (Flow SPA streams and never idles).
  await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const currentUrl = page.url();
  logger.info('Flow page loaded', { url: currentUrl.substring(0, 100) });

  if (currentUrl.includes('accounts.google.com')) {
    return { authenticated: false, url: currentUrl,
      message: 'OAuth blocked — Google detects automation. Use Chrome direct+CDP launch method.' };
  }

  return { authenticated: true, url: currentUrl };
}
