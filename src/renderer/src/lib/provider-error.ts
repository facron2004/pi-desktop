/**
 * A transient requests-per-minute / HTTP 429 failure.
 *
 * Quota and billing exhaustion are also often reported as 429, but waiting
 * does not clear them, so they stay ordinary errors.
 */
const QUOTA_ERROR = /insufficient_quota|out of budget|quota exceeded|usage limit reached|subscription_sharing_usage_limit|subscription_sharing_workplace/i
const RATE_LIMIT_ERROR = /(?<![a-z0-9])429(?![a-z0-9])|rate[\s_-]*limit|too many requests|\brpm\b|requests per minute/i

export function isRateLimitError(message: string | undefined): boolean {
  if (!message) return false
  if (QUOTA_ERROR.test(message)) return false
  return RATE_LIMIT_ERROR.test(message)
}

/** One line for the retry banner. The raw provider payload stays on `title`. */
export function rateLimitRetryText(error: string | undefined, delayMs: number): string | undefined {
  if (!isRateLimitError(error)) return undefined
  const seconds = Math.max(1, Math.round(delayMs / 1000))
  return `Rate limit reached. Waiting ${seconds}s before retrying — this conversation stays open.`
}

/** Banner text: a patient rate-limit line, or a shortened provider error. */
export function retryBannerDetail(error: string | undefined, delayMs: number): string | undefined {
  if (!error) return undefined
  const rate = rateLimitRetryText(error, delayMs)
  if (rate) return rate
  const oneLine = error.replace(/\s+/g, ' ').trim()
  if (!oneLine) return undefined
  return oneLine.length > 180 ? `${oneLine.slice(0, 179)}…` : oneLine
}
