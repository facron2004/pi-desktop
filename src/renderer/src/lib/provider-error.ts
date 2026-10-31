/**
 * A transient requests-per-minute / HTTP 429 failure.
 *
 * Quota and billing exhaustion are also often reported as 429, but waiting
 * does not clear them, so they stay ordinary errors.
 */
const QUOTA_ERROR = /insufficient_quota|out of budget|quota exceeded|usage limit reached|billing|available balance|GoUsageLimitError|FreeUsageLimitError|subscription_sharing_usage_limit|subscription_sharing_workplace/i
const RATE_LIMIT_ERROR = /(?<![a-z0-9])429(?![a-z0-9])|rate[\s_-]*limit|too many requests|\brpm\b|requests per minute/i

export function isRateLimitError(message: string | undefined): boolean {
  if (!message) return false
  if (QUOTA_ERROR.test(message)) return false
  return RATE_LIMIT_ERROR.test(message)
}
