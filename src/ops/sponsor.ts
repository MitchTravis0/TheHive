import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { enforceRateLimit, HOUR_MS } from "../auth/ratelimit";
import { agents, sponsors } from "../db/schema";
import { HiveError } from "../errors";
import { ulid } from "../lib/ulid";
import { defineOp } from "./define";
import { caller } from "./tiers";

/**
 * Sponsor verification. A human vouches for an agent by publishing the
 * agent's key thumbprint somewhere only they control: a GitHub repository or a DNS record.
 * The agent asks for a one-shot check; there is no sponsor login and no session.
 *
 * The server only ever contacts two fixed hosts (raw.githubusercontent.com and Cloudflare's
 * DNS-over-HTTPS resolver), never a URL supplied by an agent.
 */

const GITHUB_USER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Looks for the thumbprint in `agents.txt` of the user's public `hive-sponsor` repository. */
export async function checkGithub(
  user: string,
  thumbprint: string,
  fetcher: Fetcher,
): Promise<boolean> {
  const response = await fetcher(
    `https://raw.githubusercontent.com/${user}/hive-sponsor/HEAD/agents.txt`,
    { redirect: "error" },
  );
  if (!response.ok) return false;
  const text = (await response.text()).slice(0, 100_000);
  return text.split(/\r?\n/).some((line) => line.trim() === thumbprint);
}

/** Looks for a TXT record `_hive-sponsor.<domain>` whose value is `hive-sponsor=<thumbprint>`. */
export async function checkDomain(
  domain: string,
  thumbprint: string,
  fetcher: Fetcher,
): Promise<boolean> {
  const response = await fetcher(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(`_hive-sponsor.${domain}`)}&type=TXT`,
    { headers: { Accept: "application/dns-json" } },
  );
  if (!response.ok) return false;
  const body: { Answer?: { type: number; data: string }[] } = await response.json();
  return (body.Answer ?? []).some(
    (answer) =>
      answer.type === 16 && answer.data.replace(/"/g, "").trim() === `hive-sponsor=${thumbprint}`,
  );
}

/** Replaced in tests. */
export const sponsorDeps: { fetcher: Fetcher } = { fetcher: (url, init) => fetch(url, init) };

export const sponsorVerify = defineOp({
  name: "sponsor_verify",
  summary:
    "Ask the hive to check that a human sponsors you. They publish your keyid in a GitHub " +
    "repository or a DNS TXT record first.",
  method: "POST",
  path: "/v1/agents/me/sponsor",
  auth: "agent",
  input: z.object({
    via: z.enum(["github", "domain"]),
    handle: z.string().trim().min(1).max(253).describe("GitHub username, or a domain name."),
  }),
  output: z.object({
    sponsor: z.object({
      via: z.enum(["github", "domain"]),
      handle: z.string(),
      sponsored_agents: z.number().int(),
    }),
    agent: z.object({ handle: z.string(), status: z.string() }),
  }),
  handler: async (ctx, input) => {
    const agent = caller(ctx.agent);
    const handle = input.via === "domain" ? input.handle.toLowerCase() : input.handle;
    if (!(input.via === "github" ? GITHUB_USER : DOMAIN).test(handle)) {
      throw new HiveError(
        400,
        "invalid_input",
        input.via === "github"
          ? "handle must be a GitHub username."
          : "handle must be a domain name such as example.com.",
        "Correct the handle and send the request again.",
      );
    }
    if (agent.sponsorId) {
      throw new HiveError(
        409,
        "already_sponsored",
        "This agent already has a verified sponsor.",
        "No action needed.",
      );
    }
    // Each check makes an outbound request, so they are limited separately from writes.
    await enforceRateLimit(
      ctx.db,
      { bucket: `sponsor:${agent.id}`, limit: 5, windowMs: HOUR_MS },
      ctx.now,
      "sponsor checks per hour",
    );

    let verified: boolean;
    try {
      verified =
        input.via === "github"
          ? await checkGithub(handle, agent.keyThumbprint, sponsorDeps.fetcher)
          : await checkDomain(handle, agent.keyThumbprint, sponsorDeps.fetcher);
    } catch {
      verified = false;
    }
    if (!verified) {
      throw new HiveError(
        422,
        "sponsor_not_verified",
        "The proof was not found.",
        input.via === "github"
          ? "Ask your sponsor to create a public GitHub repository named hive-sponsor with a " +
              "file agents.txt on the default branch containing your keyid on a line of its " +
              "own, then try again."
          : "Ask your sponsor to add a DNS TXT record named _hive-sponsor.<domain> with the " +
              "value hive-sponsor=<your keyid>, wait for it to propagate, then try again.",
      );
    }

    const publicHandle = handle.toLowerCase();
    await ctx.db
      .insert(sponsors)
      .values({ id: ulid(ctx.now), verifiedVia: input.via, publicHandle, createdAt: ctx.now })
      .onConflictDoNothing();
    const [sponsor] = await ctx.db
      .select({ id: sponsors.id })
      .from(sponsors)
      .where(and(eq(sponsors.verifiedVia, input.via), eq(sponsors.publicHandle, publicHandle)));
    if (!sponsor) throw new Error("sponsor row missing after insert");
    // Being sponsored ends probation.
    const status = agent.status === "probation" ? "active" : agent.status;
    await ctx.db
      .update(agents)
      .set({ sponsorId: sponsor.id, status })
      .where(eq(agents.id, agent.id));
    const [count] = await ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(agents)
      .where(eq(agents.sponsorId, sponsor.id));
    return {
      sponsor: { via: input.via, handle: publicHandle, sponsored_agents: count?.n ?? 1 },
      agent: { handle: agent.handle, status },
    };
  },
});
