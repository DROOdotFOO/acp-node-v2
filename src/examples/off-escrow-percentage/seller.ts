import { base } from "@account-kit/infra";
import dotenv from "dotenv";
import {
  AcpAgent,
  AssetToken,
  PrivyAlchemyEvmProviderAdapter,
  assertNotionalMatches,
  buildSettlementDeliverable,
  computePercentageFee,
  type JobRoomEntry,
  type JobSession,
} from "../../index.js";
import {
  DEFAULT_FEE_RATE,
  FEE_UNIT,
  XOCHI_TRANSFER_OFFERING_NAME,
  boundNotionalFromIntent,
  buildTransferOffering,
  parseTransferRequirement,
} from "./jobTypes.js";

dotenv.config({ quiet: true });

// ---------------------------------------------------------------------------
// Off-escrow proportional-fee seller (facilitator).
//
//   requirement message  → parse; cross-check the DECLARED notional against the
//                          notional BOUND in the buyer's signed intent (reject a
//                          mismatch); compute fee = rate * notional;
//                          session.setBudget(fee)   ← escrows ONLY the fee
//   budget.set           → buyer funds the fee
//   job.funded           → relay the signed intent to Xochi (STUB), then
//                          submit the settlement tx hash as the deliverable
//   job.completed        → transcript
//
// The principal never touches this wallet — the SDK escrows only the fee.
//
// Required env: SELLER_WALLET_ADDRESS, SELLER_WALLET_ID, SELLER_SIGNER_PRIVATE_KEY.
// Optional: OFF_ESCROW_FEE_RATE (default 8; must match the buyer).
// ---------------------------------------------------------------------------

const chain = base;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const shortAddr = (a: string): string =>
  !a || !a.startsWith("0x") || a.length < 12
    ? a
    : `${a.slice(0, 6)}…${a.slice(-4)}`;

const log = {
  info: (m: string) => console.log(`[seller-offesc] ${m}`),
  job: (id: string | number, m: string) =>
    console.log(`[seller-offesc] [job ${id}] ${m}`),
  warn: (m: string) => console.warn(`[seller-offesc] [warn] ${m}`),
  error: (m: string, e?: unknown) =>
    console.error(`[seller-offesc] [error] ${m}`, e ?? ""),
};

/**
 * STUB for the Xochi relay. In the real flow this hands the buyer's signed
 * intent to Raxol.ACP.Xochi.Settler (`execute_signed/2`) and polls to
 * settlement on the destination chain, returning the settlement tx hash.
 * TODO: replace with the real Settler relay; no funds move here.
 */
async function relaySignedIntentToXochi(jobId: string): Promise<string> {
  return `0x${jobId.replace(/\D/g, "").padStart(64, "0").slice(0, 64)}`;
}

async function main(): Promise<void> {
  const feeRate = Number(process.env.OFF_ESCROW_FEE_RATE ?? DEFAULT_FEE_RATE);
  const offering = buildTransferOffering(feeRate);

  const seller = await AcpAgent.create({
    provider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: requireEnv("SELLER_WALLET_ADDRESS") as `0x${string}`,
      walletId: requireEnv("SELLER_WALLET_ID"),
      signerPrivateKey: requireEnv("SELLER_SIGNER_PRIVATE_KEY"),
      chains: [chain],
    }),
  });

  const sellerAddressLower = (await seller.getAddress()).toLowerCase();
  log.info(`address: ${sellerAddressLower}`);
  log.info(
    `offering "${offering.name}": ${feeRate} ${FEE_UNIT} fee, requiredFunds=false`
  );

  seller.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    if (entry.kind === "system") {
      switch (entry.event.type) {
        case "job.created":
          log.job(
            session.jobId,
            `new transfer job from ${shortAddr(entry.event.client)}`
          );
          break;

        case "job.funded":
          log.job(session.jobId, "fee funded, relaying transfer");
          try {
            const settlementTxHash = await relaySignedIntentToXochi(
              session.jobId
            );
            const deliverable = buildSettlementDeliverable({
              settlementTxHash,
              chainId: session.job?.chainId ?? session.chainId,
            });
            await session.submit(deliverable);
            log.job(session.jobId, `submitted settlement ${settlementTxHash}`);
          } catch (err) {
            log.error(`relay/submit failed on job ${session.jobId}`, err);
          }
          break;

        case "job.completed":
          log.job(session.jobId, "completed (fee released)");
          break;

        case "job.rejected":
          log.job(
            session.jobId,
            `rejected by ${shortAddr(entry.event.rejector)}: ${entry.event.reason}`
          );
          break;

        case "job.expired":
          log.job(session.jobId, "expired");
          break;
      }
    }

    if (
      entry.kind === "message" &&
      entry.contentType === "requirement" &&
      session.status === "open"
    ) {
      const rejectWithDetail = async (
        tag: string,
        detail: string
      ): Promise<void> => {
        log.job(session.jobId, `rejecting (${tag}): ${detail}`);
        await session.sendMessage(detail);
        await session.reject(tag);
      };

      if (session.job?.description !== XOCHI_TRANSFER_OFFERING_NAME) {
        await rejectWithDetail(
          "unknown offering",
          `This seller only handles "${XOCHI_TRANSFER_OFFERING_NAME}" jobs`
        );
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(entry.content);
      } catch (err) {
        await rejectWithDetail(
          "unparseable requirement",
          `Could not parse requirement payload: ${err}`
        );
        return;
      }

      const req = parseTransferRequirement(parsed);
      if (!req) {
        await rejectWithDetail(
          "invalid requirement",
          "Requirement does not match the expected transfer shape"
        );
        return;
      }

      try {
        // Objection #1 (fee-base integrity): the declared notional must match
        // the notional bound in the buyer's signed intent. Reject BEFORE any
        // payment if it doesn't. (Decoding the bound value from a real intent
        // is Xochi-specific and lives outside the SDK — stubbed here.)
        const declared = BigInt(req.notionalAtomic);
        assertNotionalMatches(declared, boundNotionalFromIntent(req.signedIntent));

        const fee = computePercentageFee(declared, offering.priceValue, FEE_UNIT);
        log.job(
          session.jobId,
          `notional ${declared} → fee ${fee} atomic (${feeRate} ${FEE_UNIT})`
        );
        await session.setBudget(AssetToken.usdcFromRaw(fee, session.chainId));
        log.job(session.jobId, "set budget to the fee");
      } catch (err) {
        await rejectWithDetail("notional/fee error", String(err));
      }
    }
  });

  await seller.start();
  log.info("ready, listening for jobs");

  const shutdown = async (signal: NodeJS.Signals) => {
    log.info(`received ${signal}, shutting down`);
    await seller.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch(console.error);
