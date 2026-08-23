import type { CompanyTypes } from "israeli-bank-scrapers";
import { existsSync, readdirSync } from "fs";
import puppeteer, {
  TargetType,
  type Browser,
  type BrowserContext,
  type LaunchOptions,
} from "puppeteer";
import { createLogger } from "../utils/logger.js";
import {
  runInLoggerContext,
  loggerContextStore,
} from "../utils/asyncContext.js";
import { initDomainTracking } from "../security/domains.js";
import { solveTurnstile } from "./cloudflareSolver.js";
import { config } from "../config.js";

// docker-entrypoint.sh imports any cert(s) mounted at /certs into the
// system trust store, which covers Node's own outbound HTTPS calls (e.g.
// storage APIs). Chromium doesn't necessarily consult that same store -
// many builds validate certificates against their own bundled root store
// regardless of the OS trust settings - so a mounted cert alone isn't
// guaranteed to make Chromium accept re-signed traffic from something
// like an HTTPS-scanning antivirus. Presence of a cert at /certs is an
// explicit signal the user already trusts whatever's doing that
// interception, so bypass Chromium's own cert validation too in that case.
const hasMountedCerts =
  existsSync("/certs") && readdirSync("/certs").length > 0;

export const browserArgs = [
  "--disable-dev-shm-usage",
  "--no-sandbox",
  // Reduce easy automation fingerprints used by anti-bot providers.
  "--disable-blink-features=AutomationControlled",
  ...(hasMountedCerts ? ["--ignore-certificate-errors"] : []),
];
export const browserExecutablePath =
  config.options.scraping.puppeteerExecutablePath || undefined;

const logger = createLogger("browser");

export async function createBrowser(): Promise<Browser> {
  const options = {
    args: browserArgs,
    executablePath: browserExecutablePath,
    // Hide the "Chrome is being controlled by automated software" marker.
    ignoreDefaultArgs: ["--enable-automation"],
  } satisfies LaunchOptions;

  logger("Creating browser", options);
  return puppeteer.launch(options);
}

export async function createSecureBrowserContext(
  browser: Browser,
  companyId: CompanyTypes,
): Promise<BrowserContext> {
  const context = await browser.createBrowserContext();
  await initDomainTracking(context, companyId);
  await initCloudflareSkipping(context);
  return context;
}

const cfChallengeUrlMarkers = [
  // The __cf_chl_rt_tk query param appears on Cloudflare's own challenge
  // redirect URL for one specific challenge flow variant.
  "__cf_chl_rt_tk",
  // challenges.cloudflare.com is the fixed domain Cloudflare's Turnstile
  // widget itself is served from, regardless of which flow triggered it -
  // a much more general signal than the query param above.
  "challenges.cloudflare.com",
];

// Well-known, stable Cloudflare/generic-WAF interstitial page titles. Titles
// (unlike a specific redirect query param) are consistent across most of
// Cloudflare's challenge variants, so checking the title catches challenge
// pages the URL-based check alone would miss.
const challengeTitleMarkers = [
  "just a moment",
  "attention required",
  "checking your browser",
  "please wait",
  "please enable cookies",
];

async function initCloudflareSkipping(browserContext: BrowserContext) {
  const activeContext = loggerContextStore.getStore();

  logger("Setting up Cloudflare skipping");
  browserContext.on(
    "targetcreated",
    runInLoggerContext(async (target) => {
      if (target.type() === TargetType.PAGE) {
        logger("Target created %o", target.type());
        const page = await target.page();
        if (!page) return;

        const userAgent = await page.evaluate(() => navigator.userAgent);
        const newUA = userAgent.replace("HeadlessChrome/", "Chrome/");
        logger("Replacing user agent", { userAgent, newUA });

        await page.setUserAgent(newUA);
        await page.setExtraHTTPHeaders({
          "accept-language": "en-US,en;q=0.9,he;q=0.8",
        });
        await page.evaluateOnNewDocument(() => {
          // Apply lightweight stealth patches before page scripts run.
          Object.defineProperty(navigator, "webdriver", {
            get: () => undefined,
          });
          Object.defineProperty(navigator, "language", {
            get: () => "en-US",
          });
          Object.defineProperty(navigator, "languages", {
            get: () => ["en-US", "en", "he"],
          });
        });

        // Guards against firing overlapping solveTurnstile() attempts if
        // multiple frame navigations land while a challenge is already
        // being handled - concurrent mouse-click attempts on the same
        // checkbox would only interfere with each other.
        let solving = false;

        page.on(
          "framenavigated",
          runInLoggerContext(async (frame) => {
            const url = frame.url();
            if (!url || url === "about:blank") return;
            logger("Frame navigated", {
              url,
              parentFrameUrl: frame.parentFrame()?.url(),
            });

            let looksLikeChallenge = cfChallengeUrlMarkers.some((marker) =>
              url.includes(marker),
            );
            if (!looksLikeChallenge) {
              try {
                const title = await frame.title();
                looksLikeChallenge = challengeTitleMarkers.some((marker) =>
                  title.toLowerCase().includes(marker),
                );
                if (looksLikeChallenge) {
                  logger("Challenge-like page title detected", { title });
                }
              } catch {
                // Frame may already be mid-navigation again; nothing to check.
              }
            }

            if (looksLikeChallenge && !solving) {
              solving = true;
              logger("Cloudflare challenge detected");
              solveTurnstile(page).then(
                (res) => {
                  solving = false;
                  logger(`Cloudflare challenge ended with ${res} for ${url}`);
                },
                (error) => {
                  solving = false;
                  logger(`Cloudflare challenge failed for ${url}`, error);
                },
              );
            }
          }, activeContext),
        );
      }
    }, activeContext),
  );
}
