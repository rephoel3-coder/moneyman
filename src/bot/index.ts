import { saveResults, storages } from "./storage/index.js";
import { AccountScrapeResult, Runner } from "../types.js";
import { createLogger, logToPublicLog } from "../utils/logger.js";
import { getAccountsSummary, getSummaryMessages } from "./messages.js";
import {
  editMessage,
  send,
  sendError,
  sendJSON,
  sendPhotos,
} from "./notifier.js";
import { runContextStore } from "../utils/asyncContext.js";
import { randomUUID } from "crypto";

const logger = createLogger("bot");

export async function runWithStorage(runScraper: Runner) {
  const message = await send("Starting...");
  if (!storages.length) {
    logger("No storages found, aborting");
    await editMessage(message?.message_id, "No storages found, aborting");
    return;
  }

  const runId = randomUUID();

  await runContextStore.run({ runId }, async () => {
    await runScraper({
      async onStatusChanged(status: Array<string>, totalTime?: number) {
        const text = status.join("\n");
        await editMessage(
          message?.message_id,
          totalTime
            ? text + `\n\nTotal time: ${totalTime.toFixed(1)} seconds`
            : text,
        );
      },
      async onResultsReady(results: AccountScrapeResult[]) {
        // Contains only company id / account number / txn counts / error
        // type - no transaction descriptions or amounts - so it's safe to
        // print here even without MONEYMAN_UNSAFE_STDOUT. Without this,
        // the only place this ever showed up was the Telegram summary
        // below - meaning a run with no Telegram configured that finished
        // without crashing but found nothing gave no way to tell which
        // account failed, or why.
        logToPublicLog(getAccountsSummary(results), logger);

        const summaryMessage = getSummaryMessages(results);
        await send(summaryMessage, "HTML");
        await saveResults(results);
      },
      async onError(e: unknown, caller: string = "unknown") {
        await sendError(e, caller);
      },
      async onBeforeStart() {},
      async failureScreenshotsHandler(photos) {
        await sendPhotos(photos);
      },
    });

    logToPublicLog("Scraping ended", logger);
  });
}
