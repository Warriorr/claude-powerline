import { readFileSync, writeFileSync } from "node:fs";

const LITELLM_FILE = "litellm-pricing.json";
const PRICING_FILE = "pricing.json";

const round2 = (value) => Math.round(value * 100) / 100;
const toMillion = (perToken) => perToken * 1_000_000;

function loadExistingPricing() {
  try {
    const current = JSON.parse(readFileSync(PRICING_FILE, "utf-8"));
    const models = {};
    for (const [key, value] of Object.entries(current)) {
      if (key !== "_meta" && !key.startsWith("claude-3-")) {
        models[key] = value;
      }
    }
    console.log(
      `Loaded ${Object.keys(models).length} existing models to preserve`,
    );
    return models;
  } catch {
    console.log("No existing pricing.json found, starting fresh");
    return {};
  }
}

function extractCachePricing(modelData, inputPerMillion) {
  const cacheWrite5m = modelData.cache_creation_input_token_cost
    ? toMillion(modelData.cache_creation_input_token_cost)
    : inputPerMillion * 1.25;

  const cacheWrite1h = modelData.cache_creation_input_token_cost_above_1hr
    ? toMillion(modelData.cache_creation_input_token_cost_above_1hr)
    : inputPerMillion * 2.0;

  const cacheRead = modelData.cache_read_input_token_cost
    ? toMillion(modelData.cache_read_input_token_cost)
    : inputPerMillion * 0.1;

  return {
    cacheWrite5m: round2(cacheWrite5m),
    cacheWrite1h: round2(cacheWrite1h),
    cacheRead: round2(cacheRead),
  };
}

function extractClaudeModels(litellmData) {
  const models = {};

  for (const [modelId, modelData] of Object.entries(litellmData)) {
    if (
      !modelId.startsWith("claude-") ||
      modelId.startsWith("claude-3-") ||
      !modelData ||
      typeof modelData !== "object"
    ) {
      continue;
    }

    const inputPrice =
      modelData.input_cost_per_token || modelData.prompt_cost_per_token || 0;
    const outputPrice =
      modelData.output_cost_per_token ||
      modelData.completion_cost_per_token ||
      0;

    if (inputPrice === 0 || outputPrice === 0) {
      continue;
    }

    const inputPerMillion = toMillion(inputPrice);
    const outputPerMillion = toMillion(outputPrice);
    const cachePricing = extractCachePricing(modelData, inputPerMillion);

    models[modelId] = {
      name: modelId,
      input: round2(inputPerMillion),
      output: round2(outputPerMillion),
      cache_write_5m: cachePricing.cacheWrite5m,
      cache_write_1h: cachePricing.cacheWrite1h,
      cache_read: cachePricing.cacheRead,
    };
  }

  return models;
}

function buildPricingFile(existing, fetched) {
  const merged = { ...existing, ...fetched };

  const result = {
    _meta: {
      source:
        "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
      updated: new Date().toISOString().split("T")[0],
      currency: "USD",
      unit: "per_million_tokens",
    },
  };

  for (const [key, value] of Object.entries(merged)) {
    result[key] = value;
  }

  return result;
}

const litellmData = JSON.parse(readFileSync(LITELLM_FILE, "utf-8"));
const existing = loadExistingPricing();
const fetched = extractClaudeModels(litellmData);
const result = buildPricingFile(existing, fetched);

writeFileSync(PRICING_FILE, JSON.stringify(result, null, 2) + "\n");

const freshCount = Object.keys(fetched).length;
const preservedCount = Object.keys(existing).length;
const totalCount = Object.keys(result).length - 1;
console.log(
  `Updated pricing: ${freshCount} fresh + ${preservedCount} preserved = ${totalCount} total models`,
);
