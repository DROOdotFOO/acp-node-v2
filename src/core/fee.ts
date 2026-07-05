import type { AcpAgentOffering } from "../events/types.js";

/**
 * Unit of an offering's percentage `priceValue`.
 *
 * IMPORTANT: this is a backend convention that MUST be confirmed against the
 * Virtuals registry before it is relied upon. Raxol's agent prices in basis
 * points; the Virtuals frontend may display percent. {@link computePercentageFee}
 * takes the unit explicitly and never guesses.
 */
export type FeeUnit = "bps" | "percent";

// `priceValue` is a JS number and may be fractional (e.g. 8.5 bps). We scale it
// to an integer at this fixed precision so the fee math stays in bigint for the
// (large) notional. Six decimals of rate precision is ample for bps / percent.
const RATE_PRECISION = 1_000_000n;

/**
 * Compute a proportional fee from a notional amount.
 *
 * The fee is returned in the SAME atomic units / token as `notionalAtomic`.
 * When the notional token differs from the fee (budget) token, the caller must
 * USD-normalize first — the SDK does not know cross-token rates.
 *
 * Rounds DOWN (integer division). `priceValue` may be fractional.
 *
 * @param notionalAtomic Fee notional in atomic units (e.g. 1000 USDC ->
 *   1_000_000_000n at 6 decimals).
 * @param priceValue The offering's `priceValue` (the rate).
 * @param unit Whether `priceValue` is basis points or percent. See {@link FeeUnit}.
 */
export function computePercentageFee(
  notionalAtomic: bigint,
  priceValue: number,
  unit: FeeUnit
): bigint {
  if (notionalAtomic < 0n) {
    throw new Error(
      `notionalAtomic must be non-negative, got ${notionalAtomic}`
    );
  }
  if (!Number.isFinite(priceValue) || priceValue < 0) {
    throw new Error(
      `priceValue must be a non-negative finite number, got ${priceValue}`
    );
  }
  const scaledRate = BigInt(Math.round(priceValue * Number(RATE_PRECISION)));
  const denom = (unit === "bps" ? 10_000n : 100n) * RATE_PRECISION;
  return (notionalAtomic * scaledRate) / denom;
}

/**
 * Read the fee notional (atomic, as bigint) from a requirement payload, using
 * the field named by `offering.feeBasisField`. Throws if the offering declares
 * no fee-basis field, or the requirement value is missing / not an integer
 * atomic amount.
 */
export function readFeeBasis(
  offering: AcpAgentOffering,
  requirementData: Record<string, unknown>
): bigint {
  const field = offering.feeBasisField;
  if (!field) {
    throw new Error(
      `Offering "${offering.name}" does not declare feeBasisField; cannot derive a proportional fee`
    );
  }
  const raw = requirementData[field];
  if (raw === undefined || raw === null) {
    throw new Error(`Requirement is missing fee-basis field "${field}"`);
  }
  return toBigIntAtomic(raw, field);
}

function toBigIntAtomic(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(
        `Fee-basis field "${field}" must be an integer atomic amount, got ${value}`
      );
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  throw new Error(
    `Fee-basis field "${field}" is not a valid atomic amount: ${String(value)}`
  );
}

/**
 * Assert that the notional the buyer DECLARED in the requirement matches the
 * notional BOUND in their signed intent (Permit2 / ERC-3009). A provider should
 * call this before `setBudget` so an under- or over-declared notional is
 * rejected before any payment.
 *
 * NOTE: extracting `bound` from the signed intent is intent-standard-specific
 * (Xochi / Permit2 / ERC-3009) and intentionally lives OUTSIDE this SDK — this
 * helper only compares. Exact-match today; if a tolerance convention is agreed
 * with Virtuals, extend here.
 */
export function assertNotionalMatches(declared: bigint, bound: bigint): void {
  if (declared !== bound) {
    throw new Error(
      `Declared notional ${declared} does not match the notional bound in the signed intent ${bound}`
    );
  }
}
