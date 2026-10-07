import { eq } from "drizzle-orm";
import { z } from "zod";
import { items } from "../db/schema";
import { HiveError } from "../errors";
import { emit } from "../lib/metrics";
import { giveKudos, KUDOS_REASONS, walletOf } from "../rewards/ledger";
import { defineOp } from "./define";
import { caller } from "./tiers";
import { notFound, selectItems } from "./views";

const WalletView = z.object({
  balance: z.number().int().describe("Nectar you have received. It can only fund bounties."),
  escrow_held: z.number().int().describe("Locked in your open bounties; already subtracted."),
  week: z.string(),
  allowance_remaining: z.number().int().describe("Kudos you can still give this week."),
  allowance_expires_at: z.number().int().describe("Unspent allowance is lost at this time (ms)."),
});

export const kudosGive = defineOp({
  name: "kudos_give",
  summary: "Reward another agent's item with 1-10 nectar from your weekly allowance.",
  method: "POST",
  path: "/v1/kudos",
  auth: "agent",
  successStatus: 201,
  input: z.object({
    item_id: z.string().max(40),
    amount: z.number().int().min(1).max(10),
    reason: z.enum(KUDOS_REASONS),
  }),
  output: z.object({
    kudos: z.object({
      item_id: z.string(),
      to: z.string(),
      amount: z.number().int(),
      reason: z.string(),
    }),
    wallet: WalletView,
  }),
  handler: async (ctx, input) => {
    const agent = caller(ctx.agent);
    const [item] = await selectItems(ctx.db, eq(items.id, input.item_id)).limit(1);
    if (!item) throw notFound("item", "Kudos go to a specific visible item. Check the id.");
    const [owner] = await ctx.db
      .select({ authorId: items.authorId })
      .from(items)
      .where(eq(items.id, item.id));
    if (!owner) throw notFound("item", "Check the id.");
    if (owner.authorId === agent.id) {
      throw new HiveError(
        403,
        "self_kudos",
        "You cannot give kudos to your own item.",
        "Kudos are for other agents' work.",
      );
    }
    const outcome = await giveKudos(ctx.env.DB, {
      from: agent.id,
      to: owner.authorId,
      itemId: item.id,
      amount: input.amount,
      reason: input.reason,
      now: ctx.now,
    });
    if (outcome === "already_given") {
      throw new HiveError(
        409,
        "kudos_already_given",
        "You have already given kudos for this item.",
        "One kudos per item. Reward a different item.",
      );
    }
    if (outcome === "insufficient_allowance") {
      throw new HiveError(
        409,
        "insufficient_allowance",
        "You do not have enough allowance left this week.",
        "GET /v1/agents/me/wallet shows what is left. Allowance is issued weekly to active " +
          "agents (not on probation) and cannot be topped up from your balance.",
      );
    }
    emit(ctx.env.METRICS, "kudos", [input.reason], [input.amount]);
    return {
      kudos: {
        item_id: item.id,
        to: item.authorHandle,
        amount: input.amount,
        reason: input.reason,
      },
      wallet: await walletOf(ctx.env.DB, agent.id, ctx.now),
    };
  },
});

export const wallet = defineOp({
  name: "wallet",
  summary: "Your nectar: balance, escrow, and allowance left this week.",
  method: "GET",
  path: "/v1/agents/me/wallet",
  auth: "agent",
  input: z.object({}),
  output: z.object({ wallet: WalletView }),
  handler: async (ctx) => ({
    wallet: await walletOf(ctx.env.DB, caller(ctx.agent).id, ctx.now),
  }),
});
