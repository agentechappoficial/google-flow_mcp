import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import net from 'node:net';
import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { FlowError, ErrorCodes } from '../utils/errors.js';
import { getDefaultChromePath } from '../utils/platform.js';
import { isFlowUrl } from '../utils/sanitize.js';

let browser = null;
let context = null;
let page = null;
let isConnected = false;
let selfLaunched = false;
// Serialize concurrent connect/launch calls (prevents double-launch on same port).
let connectPromise = null;

function isPageAlive(p) {
  try {
    return !!p && !p.isClosed();
  } catch {
    return false;
  }
}

export function isBrowserConnected() {
  try {
    if (!isConnected || !browser) return false;
    if (!browser.isConnected()) return false;
    return isPageAlive(page);
  } catch {
    return false;
  }
}

// A CDP listener on localhost is not proof that it belongs to this MCP.
// Refuse occupied ports before starting a new browser, rather than attaching
// to an unrelated browser after a failed launch.
async function assertCdpPortAvailable(port) {
  const number = Number(port);
  if (!Number.isInteger(number) || number < 1024 || number > 65535) {
    throw new FlowError(ErrorCodes.CONFIG_ERROR, 'CDP port must be an integer between 1024 and 65535');
  }
  const occupied = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: number });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('CDP port check timed out')); });
  });
  if (occupied) {
    throw new FlowError(ErrorCodes.CONFIG_ERROR, 'CDP port already occupied; refusing to attach to an unverified browser');
  }
}

// Never attach to an arbitrary browser session: CDP grants access to all its tabs and cookies.
async function attachToExisting(cdpUrl) {
  if (process.env.FLOW_ALLOW_EXISTING_CDP !== '1') {
    throw new FlowError(ErrorCodes.CONFIG_ERROR, 'Attaching to an existing CDP browser is disabled for security.');
  }
  if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(cdpUrl)) {
    throw new FlowError(ErrorCodes.CONFIG_ERROR, 'Only loopback CDP is allowed');
  }
  const existing = await chromium.connectOverCDP(cdpUrl);
  const contexts = existing.contexts();
  let ctx = contexts[0] || null;
  // connectOverCDP to a real Chrome should always have a context; only
  // create one as a last resort (it would be incognito, no profile cookies).
  if (!ctx) {
    logger.warn('CDP has no contexts — creating a fresh one (no profile cookies)');
    ctx = await existing.newContext();
  }
  const pages = ctx.pages();
  // Prefer a Flow tab if one exists; avoid chrome:// / devtools pages.
  let pg = pages.find(p => {
    try {
      const u = p.url();
      return isFlowUrl(u);
    } catch { return false; }
  }) || pages.find(p => {
    try {
      const u = p.url();
      return u.startsWith('http') && !u.startsWith('chrome');
    } catch { return false; }
  }) || pages[0] || await ctx.newPage();
  return { browser: existing, context: ctx, page: pg, reused: true };
}

export async function connectToBrowser(options = {}) {
  if (isBrowserConnected()) {
    logger.info('Already connected to browser');
    return { browser, context, page };
  }
  if (connectPromise) return connectPromise;
  connectPromise = (async () => {
    const cdpPort = options.cdpPort || get('cdpPort', 9222);
    const cdpUrl = `http://127.0.0.1:${cdpPort}`;

    try {
      // Try connecting to existing Chrome instance via CDP
      logger.info('Attempting CDP connection', { url: cdpUrl });
      const attached = await attachToExisting(cdpUrl);
      browser = attached.browser;
      context = attached.context;
      page = attached.page;
      isConnected = true;
      selfLaunched = false;
      wireDisconnectHandler();
      logger.info('Browser connected successfully');
      return { browser, context, page };
    } catch (err) {
      logger.warn('CDP connection failed, will launch new browser', { error: err.message });
      return await launchNewBrowser(cdpPort, options);
    } finally {
      connectPromise = null;
    }
  })();
  return connectPromise;
}

function wireDisconnectHandler() {
  try {
    browser?.on?.('disconnected', () => {
      logger.warn('Browser disconnected event — resetting connection state');
      browser = null;
      context = null;
      page = null;
      isConnected = false;
      selfLaunched = false;
    });
  } catch { /* ignore */ }
}

async function launchNewBrowser(cdpPort, options = {}) {
  const chromePath = options.chromePath || get('chromeExecutable') || getDefaultChromePath();
  const { getFlowHome } = await import('../utils/config.js');
  const profileDir = options.profileDir || path.join(getFlowHome(), 'chrome-profile-kiara');

  if (!chromePath || !fs.existsSync(chromePath)) {
    throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR,
      `Chrome not found${chromePath ? ` at ${chromePath}` : ''}. Set "chromeExecutable" in config/flow.config.json to your Chrome install path.`);
  }

  const headlessOpt = options.headless ?? get('headless', false);
  const args = [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    `--window-size=1920,1080`,
  ];

  if (headlessOpt) {
    args.push('--headless=new');
  }

  // Do NOT kill a user's existing Chrome on this port. If something is already
  // listening, reuse it instead of closing it (closing kills all user tabs).
  try {
    const attached = await attachToExisting(`http://127.0.0.1:${cdpPort}`);
    browser = attached.browser;
    context = attached.context;
    page = attached.page;
    isConnected = true;
    selfLaunched = false;
    wireDisconnectHandler();
    logger.info('Reusing existing Chrome on CDP port instead of launching new');
    return { browser, context, page };
  } catch {
    // No existing instance, proceed to launch.
  }

  await assertCdpPortAvailable(cdpPort);
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  logger.info('Launching Chrome with Kiara profile', {
    chromePath,
    profileDir,
    cdpPort,
  });

  browser = await chromium.launch({
    executablePath: chromePath,
    args,
    headless: false,
  });
  selfLaunched = true;

  const contexts = browser.contexts();
  context = contexts[0] || await browser.newContext();
  const pages = context.pages();
  page = pages[0] || await context.newPage();
  isConnected = true;
  wireDisconnectHandler();

  logger.info('New browser launched successfully');
  return { browser, context, page };
}

/**
 * Launch Chrome DIRECTLY (not via Playwright) to avoid automation detection
 * (navigator.webdriver=false). Creates temp user-data-dir with Default cookies,
 * launches Chrome via shell, then connects Playwright via CDP.
 */
export async function launchChromeDirect(options = {}) {
  const chromePath = options.chromePath || get('chromeExecutable') || getDefaultChromePath();
  const cdpPort = options.cdpPort || get('cdpPort', 9222);
  const headless = options.headless ?? get('headless', false);

  if (isBrowserConnected()) {
    logger.info('Already connected, reusing browser');
    return { browser, context, page };
  }
  if (connectPromise) return connectPromise;
  connectPromise = (async () => {
    if (!chromePath || !fs.existsSync(chromePath)) {
      throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR,
        `Chrome not found${chromePath ? ` at ${chromePath}` : ''}. Set "chromeExecutable" in config/flow.config.json to your Chrome install path.`);
    }

    // Prefer reusing a running Chrome (started via `npm run start-browser`).
    // Never kill the user's browser — closing the CDP browser kills all tabs.
    try {
      const attached = await attachToExisting(`http://127.0.0.1:${cdpPort}`);
      browser = attached.browser;
      context = attached.context;
      page = attached.page;
      isConnected = true;
      selfLaunched = false;
      wireDisconnectHandler();
      logger.info('Reusing running Chrome via CDP (no new launch needed)');
      return { browser, context, page };
    } catch {
      // Nothing listening — fall through to direct launch.
    }

    await assertCdpPortAvailable(cdpPort);

    // A dedicated, persistent profile is required. Never copy browser cookies.
    // Reject symlinks and profiles outside the service user's private home.
    const home = fs.realpathSync(process.env.HOME || '/nonexistent');
    const profileDir = path.resolve(options.profileDir || path.join(home, '.local/share/google-flow-mcp/chrome-profile'));
    if (profileDir === home || !profileDir.startsWith(home + path.sep)) {
      throw new FlowError(ErrorCodes.CONFIG_ERROR, 'Dedicated Chrome profile must be inside the service user home');
    }
    if (fs.existsSync(profileDir) && fs.lstatSync(profileDir).isSymbolicLink()) {
      throw new FlowError(ErrorCodes.CONFIG_ERROR, 'Chrome profile cannot be a symlink');
    }
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    const resolvedProfile = fs.realpathSync(profileDir);
    if (!resolvedProfile.startsWith(home + path.sep)) {
      throw new FlowError(ErrorCodes.CONFIG_ERROR, 'Chrome profile resolves outside the service user home');
    }
    fs.chmodSync(profileDir, 0o700);

    const args = [
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      `--profile-directory=${get('chromeProfile', 'Default')}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
    ];
    if (headless) args.push('--headless=new');

    logger.info('Launching Chrome directly', { chromePath, cdpPort, headless });

    const chromeProcess = spawn(chromePath, args, { stdio: 'ignore', detached: true });
    chromeProcess.unref();
    global.__chromeProcess = chromeProcess;
    selfLaunched = true;

    const cdpUrl = `http://127.0.0.1:${cdpPort}`;
    let attempts = 0;
    while (attempts < 20) {
      try {
        const resp = await fetch(`${cdpUrl}/json/version`);
        if (resp.ok) break;
      } catch { }
      await new Promise(r => setTimeout(r, 1000));
      attempts++;
    }
    if (attempts >= 20) {
      throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR, 'Chrome CDP failed to start in time');
    }

    browser = await chromium.connectOverCDP(cdpUrl);
    const ctxs = browser.contexts();
    context = ctxs[0] || await browser.newContext();
    const pgs = context.pages();
    page = pgs[0] || await context.newPage();
    isConnected = true;
    wireDisconnectHandler();

    let webdriver = 'unknown';
    try {
      webdriver = await page.evaluate(() => navigator.webdriver);
    } catch (e) {
      logger.warn('webdriver probe failed — marking disconnected', { error: e.message });
      isConnected = false;
      throw new FlowError(ErrorCodes.PLAYWRIGHT_ERROR, `CDP page not usable: ${e.message}`);
    }

    logger.info('Chrome direct + CDP connected', { webdriver });
    return { browser, context, page };
  })();
  try {
    return await connectPromise;
  } finally {
    connectPromise = null;
  }
}

export async function closeBrowser() {
  // Close CDP connection first, then kill self-launched Chrome, then clean temp dir
  // (rmSync fails on Windows while files are still locked).
  if (browser) {
    try {
      if (selfLaunched) {
        await browser.close();
      } else {
        // User-owned Chrome: just detach, do NOT close their tabs.
        await browser.close().catch(() => {});
      }
    } catch (err) {
      logger.warn('Error closing browser', { error: err.message });
    }
  }
  browser = null;
  context = null;
  page = null;
  isConnected = false;
  selfLaunched = false;
  if (global.__chromeProcess) {
    try { global.__chromeProcess.kill(); } catch { }
    // Give Windows time to release file locks before rmSync.
    await new Promise(r => setTimeout(r, 500)).catch(() => {});
    global.__chromeProcess = null;
  }
  if (global.__chromeTempDir) {
    const dir = global.__chromeTempDir;
    global.__chromeTempDir = null;
    // Retry once on Windows (EBUSY/EPERM while Chrome shuts down).
    for (let i = 0; i < 2; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch (e) {
        logger.warn('Temp cleanup failed', { error: e.message, attempt: i + 1 });
        await new Promise(r => setTimeout(r, 1000)).catch(() => {});
      }
    }
  }
  logger.info('Browser disconnected');
}

export function getPage() {
  if (!isPageAlive(page) || !isConnected) {
    throw new FlowError(ErrorCodes.BROWSER_NOT_CONNECTED, 'Browser not connected or page was closed. Call flow_connect first.');
  }
  return page;
}

export function getContext() {
  return context;
}

export function setPage(newPage) {
  page = newPage;
}

export function getBrowser() {
  return browser;
}

export function setBrowser(b) {
  browser = b;
}

export function setConnected(connected) {
  isConnected = connected;
}

export function setContext(ctx) {
  context = ctx;
}

export function isSelfLaunched() {
  return selfLaunched;
}
