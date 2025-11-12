import consola from "consola"

import modelConsumptionData from "./model-consumption.json"
import { state } from "./state"

/**
 * Get model consumption value
 */
function getModelConsumption(modelName: string): number {
  const consumptionMap = new Map(
    modelConsumptionData.models.map((m) => [m.name, m.consumption]),
  )
  const consumption = consumptionMap.get(modelName) || "N/A"

  if (consumption === "N/A") return 999
  const match = consumption.match(/^([\d.]+)x$/)
  return match ? Number.parseFloat(match[1]) : 999
}

/**
 * Check if premium interactions usage is high (>50%)
 */
function isPremiumUsageHigh(): boolean {
  if (!state.premiumInteractions) {
    return false
  }

  const usagePercent = 100 - state.premiumInteractions.percent_remaining
  return usagePercent > 50
}

/**
 * Get all 0x consumption models
 */
function getZeroConsumptionModels(): string[] {
  const availableModels = state.models?.data.filter(
    (m) => typeof m.capabilities?.limits?.max_context_window_tokens === "number",
  )

  if (!availableModels) return []

  return availableModels
    .filter((m) => getModelConsumption(m.name) === 0)
    .map((m) => m.id)
}

/**
 * Find a matching model from available models
 * If exact match exists, return it
 * If no exact match, try to find by prefix (e.g., claude-haiku-4-5-xxx -> claude-haiku-4.5)
 * If premium usage >50%, only match to 0x consumption models
 */
export function findMatchingModel(requestedModel: string): string | null {
  const availableModels = state.models?.data.filter(
    (m) => typeof m.capabilities?.limits?.max_context_window_tokens === "number",
  )

  if (!availableModels || availableModels.length === 0) {
    return null
  }

  const highUsage = isPremiumUsageHigh()
  const zeroConsumptionModels = highUsage ? getZeroConsumptionModels() : []
  const allAvailableModelIds = availableModels.map((m) => m.id)

  consola.debug(`Looking for match for: ${requestedModel}`)
  consola.debug(`All available models: ${allAvailableModelIds.join(", ")}`)

  // Try exact match first (always allow exact match, even if high usage)
  if (allAvailableModelIds.includes(requestedModel)) {
    // If high usage and model is not 0x, warn but still allow
    if (highUsage && !zeroConsumptionModels.includes(requestedModel)) {
      consola.warn(
        `⚠️  Premium usage >50%, but exact match found: ${requestedModel}`,
      )
    }
    return requestedModel
  }

  // For fuzzy matching when usage is high, only consider 0x models
  let availableModelIds = allAvailableModelIds
  if (highUsage && zeroConsumptionModels.length > 0) {
    consola.info(
      `⚠️  Premium usage >50%, restricting fuzzy matching to 0x consumption models`,
    )
    availableModelIds = zeroConsumptionModels
    consola.debug(`0x models for matching: ${availableModelIds.join(", ")}`)
  }

  // Normalize the requested model
  // 1. Replace underscores with hyphens
  // 2. Remove date suffix (8 digits at the end)
  // 3. Replace version numbers: 4-5 -> 4.5
  let normalizedRequested = requestedModel
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/-(\d{8})$/, "") // Remove -20251001 style suffix
    .replace(/(\d)-(\d)/g, "$1.$2") // Replace 4-5 with 4.5

  consola.debug(`Normalized requested: ${normalizedRequested}`)

  // Try exact match after normalization
  for (const availableId of availableModelIds) {
    if (availableId.toLowerCase() === normalizedRequested) {
      consola.info(
        `🔄 Model normalized match: '${requestedModel}' -> '${availableId}'`,
      )
      return availableId
    }
  }

  // Try prefix matching
  for (const availableId of availableModelIds) {
    const normalizedAvailable = availableId.toLowerCase()

    // Check if they start with each other
    if (
      normalizedAvailable.startsWith(normalizedRequested) ||
      normalizedRequested.startsWith(normalizedAvailable)
    ) {
      consola.info(
        `🔄 Model prefix match: '${requestedModel}' -> '${availableId}'`,
      )
      return availableId
    }
  }

  // Try fuzzy matching by comparing main parts
  const requestedParts = normalizedRequested.split("-")
  for (const availableId of availableModelIds) {
    const normalizedAvailable = availableId.toLowerCase()
    const availableParts = normalizedAvailable.split("-")

    // Match by comparing first N-1 parts (everything except version)
    if (requestedParts.length >= 3 && availableParts.length >= 3) {
      const requestedBase = requestedParts.slice(0, -1).join("-")
      const availableBase = availableParts.slice(0, -1).join("-")

      if (requestedBase === availableBase) {
        consola.info(
          `🔄 Model base match: '${requestedModel}' -> '${availableId}'`,
        )
        return availableId
      }
    }
  }

  // Fallback: if high usage and no match found, use first 0x model
  if (highUsage && zeroConsumptionModels.length > 0) {
    consola.warn(
      `⚠️  No matching 0x model found, falling back to: ${zeroConsumptionModels[0]}`,
    )
    return zeroConsumptionModels[0]
  }

  consola.debug(`No match found for: ${requestedModel}`)
  return null
}

/**
 * Validate and potentially replace the requested model
 * Returns the validated model ID or throws/returns error info
 */
export function validateAndReplaceModel(requestedModel: string): {
  success: boolean
  model?: string
  error?: {
    message: string
    code: string
    param: string
    type: string
  }
} {
  const availableModels = state.models?.data.filter(
    (m) => typeof m.capabilities?.limits?.max_context_window_tokens === "number",
  )
  const availableModelIds = availableModels?.map((m) => m.id) || []

  const matchedModel = findMatchingModel(requestedModel)

  if (!matchedModel) {
    consola.error(`❌ Model not available: ${requestedModel}`)
    consola.error(`Available models: ${availableModelIds.join(", ")}`)

    return {
      success: false,
      error: {
        message: `The requested model '${requestedModel}' is not supported. Available models: ${availableModelIds.join(", ")}`,
        code: "model_not_supported",
        param: "model",
        type: "invalid_request_error",
      },
    }
  }

  if (matchedModel !== requestedModel) {
    consola.success(
      `✓ Model matched and replaced: ${requestedModel} -> ${matchedModel}`,
    )
  } else {
    consola.success(`✓ Model validated: ${matchedModel}`)
  }

  return {
    success: true,
    model: matchedModel,
  }
}
