import { createApp } from "./app.js";
import { CLAUDE_MODEL, MODEL_WAS_FORCED, config } from "./config.js";
import { log } from "./logger.js";

const app = createApp();

app.listen(config.port, () => {
  log.info(`Welliva API listening on http://localhost:${config.port}`);
  log.info(`Model: ${CLAUDE_MODEL} (Haiku-locked)`);
  if (MODEL_WAS_FORCED) {
    log.warn(
      "A non-Haiku CLAUDE_MODEL was configured and IGNORED. This backend is Haiku-only by design.",
    );
  }
  if (!config.fdcApiKey) {
    log.warn(
      "FDC_API_KEY is not set. /v1/nutrition/lookup will skip USDA FoodData Central " +
        "and answer with AI estimates only. Free key: https://fdc.nal.usda.gov/api-key-signup.html",
    );
  }
});
