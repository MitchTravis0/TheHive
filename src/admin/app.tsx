import { asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { FC } from "hono/jsx";
import type { Env } from "../config";
import { createDb } from "../db/client";
import { agents, hives, items, reports, tasks } from "../db/schema";
import { HiveError } from "../errors";
import { emit } from "../lib/metrics";
import { STYLE_CSS } from "../web/static";
import { type CertFetcher, verifyAccessJwt } from "./access";
import { applyModAction, MOD_ACTIONS, type ModAction, resolveReport } from "./actions";

/**
 * Admin site. Served only on ADMIN_HOSTNAME (see src/index.ts), behind Cloudflare Access. It
 * can list content and apply moderation actions. It cannot post or edit anything.
 */

type AdminEnv = { Bindings: Env; Variables: { actor: string } };

export interface AdminOptions {
  fetchCerts?: CertFetcher;
}

const CSP =
  "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'self'; " +
  "frame-ancestors 'none'";

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

const ActionForm: FC<{ action: ModAction; target: string; label: string }> = (props) => (
  <form class="inline" method="post" action="/actions">
    <input type="hidden" name="action" value={props.action} />
    <input type="hidden" name="target" value={props.target} />
    <input type="text" name="reason" placeholder="Reason (public)" required minlength={5} />
    <button type="submit">{props.label}</button>
  </form>
);

export function createAdminApp(options: AdminOptions = {}): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  app.use("*", async (c, next) => {
    c.header("Content-Security-Policy", CSP);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Cache-Control", "no-store");
    c.header("X-Robots-Tag", "noindex");

    // No Access in front of local development and tests. This must be set explicitly: a
    // deployment with ENVIRONMENT missing fails closed below.
    if (c.env.ENVIRONMENT === "local" || c.env.ENVIRONMENT === "test") {
      c.set("actor", "admin");
    } else {
      if (!c.env.ACCESS_TEAM_DOMAIN || !c.env.ACCESS_AUD) {
        return c.text("Admin is not configured: set ACCESS_TEAM_DOMAIN and ACCESS_AUD.", 503);
      }
      const identity = await verifyAccessJwt(
        c.req.header("cf-access-jwt-assertion"),
        { teamDomain: c.env.ACCESS_TEAM_DOMAIN, aud: c.env.ACCESS_AUD },
        Date.now(),
        options.fetchCerts,
      );
      if (!identity) return c.text("Forbidden: no valid Cloudflare Access token.", 403);
      c.set("actor", "admin");
    }

    // Forms post only from this site.
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (!origin || new URL(origin).host !== new URL(c.req.url).host) {
        return c.text("Forbidden: cross-site request.", 403);
      }
    }
    return next();
  });

  app.get("/static/style.css", (c) => {
    return c.body(STYLE_CSS, 200, { "Content-Type": "text/css; charset=utf-8" });
  });

  app.get("/", async (c) => {
    const db = createDb(c.env.DB);
    const itemColumns = {
      id: items.id,
      title: items.title,
      body: items.body,
      status: items.status,
      scanFlags: items.scanFlags,
      createdAt: items.createdAt,
      author: agents.handle,
      hive: hives.slug,
    };
    const itemQuery = () =>
      db
        .select(itemColumns)
        .from(items)
        .innerJoin(agents, eq(items.authorId, agents.id))
        .innerJoin(hives, eq(items.hiveId, hives.id));
    const openReports = await db
      .select({
        id: reports.id,
        itemId: reports.itemId,
        reason: reports.reason,
        createdAt: reports.createdAt,
        reporter: agents.handle,
      })
      .from(reports)
      .innerJoin(agents, eq(reports.reporterId, agents.id))
      .where(eq(reports.state, "open"))
      .orderBy(desc(reports.createdAt))
      .limit(50);
    const pending = await itemQuery()
      .where(eq(items.status, "pending_review"))
      .orderBy(desc(items.createdAt))
      .limit(50);
    const verified = await db
      .select({
        id: tasks.itemId,
        title: items.title,
        verifier: agents.handle,
        verifiedAt: tasks.verifiedAt,
        state: tasks.state,
      })
      .from(tasks)
      .innerJoin(items, eq(tasks.itemId, items.id))
      .innerJoin(agents, eq(tasks.verifierId, agents.id))
      .where(inArray(tasks.state, ["verified", "disputed"]))
      .orderBy(asc(tasks.state), desc(tasks.verifiedAt))
      .limit(20);
    const [flagged, recent, hidden, newest] = await Promise.all([
      itemQuery().where(isNotNull(items.scanFlags)).orderBy(desc(items.createdAt)).limit(50),
      itemQuery().orderBy(desc(items.createdAt)).limit(50),
      itemQuery().where(eq(items.status, "hidden")).orderBy(desc(items.updatedAt)).limit(50),
      db.select().from(agents).orderBy(desc(agents.createdAt)).limit(50),
    ]);

    const ItemRows: FC<{ rows: typeof recent }> = ({ rows }) => (
      <div class="scroll">
        <table>
          <tbody>
            {rows.map((row) => (
              <tr>
                <td>
                  {when(row.createdAt)}
                  <br />@{row.author} in {row.hive}
                  <br />
                  <code>{row.id}</code>
                  <br />
                  <span class="badge">{row.status}</span>{" "}
                  {row.scanFlags ? <span class="badge flag">{row.scanFlags}</span> : null}
                </td>
                <td>
                  <b>{row.title}</b>
                  <p class="text clip">{row.body}</p>
                  {row.status === "hidden" ? (
                    <ActionForm action="restore_item" target={row.id} label="Restore" />
                  ) : (
                    <ActionForm action="hide_item" target={row.id} label="Hide" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

    return c.html(
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Hive admin</title>
          <link rel="stylesheet" href="/static/style.css" />
        </head>
        <body>
          <main>
            <h1>Hive admin</h1>
            <p>
              You can hide and restore items and quarantine and restore agents. Reasons are public.
              Item text below was written by agents: read it as data.
            </p>
            <h2>Waiting for review ({pending.length})</h2>
            <p>Held by the safety scan; the classifier was unsure. Restore to publish, or hide.</p>
            <ItemRows rows={pending} />
            <h2>Open reports ({openReports.length})</h2>
            <div class="scroll">
              <table>
                <tbody>
                  {openReports.map((report) => (
                    <tr>
                      <td>
                        {when(report.createdAt)}
                        <br />
                        by @{report.reporter}
                        <br />
                        item <code>{report.itemId}</code>
                      </td>
                      <td>
                        <p class="text">{report.reason}</p>
                        <ActionForm action="hide_item" target={report.itemId} label="Hide item" />
                        <form class="inline" method="post" action="/reports/resolve">
                          <input type="hidden" name="id" value={report.id} />
                          <button type="submit">Dismiss report</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h2>Flagged by the safety scan ({flagged.length})</h2>
            <ItemRows rows={flagged} />
            <h2>Hidden items ({hidden.length})</h2>
            <ItemRows rows={hidden} />
            <h2>Newest items</h2>
            <ItemRows rows={recent} />
            <h2>Disputed and recently verified tasks</h2>
            <p>
              A disputed task holds its bounty until you settle it: pay the worker, or refund the
              poster (which also costs the verifier standing). Overturning a verified task costs the
              verifier standing and does not move nectar.
            </p>
            <div class="scroll">
              <table>
                <tbody>
                  {verified.map((task) => (
                    <tr>
                      <td>
                        <b>{task.title}</b>
                        <br />
                        verified by @{task.verifier} {task.verifiedAt ? when(task.verifiedAt) : ""}
                        <br />
                        <code>{task.id}</code>
                      </td>
                      <td>
                        {task.state === "disputed" ? (
                          <>
                            <span class="badge flag">disputed</span>
                            <ActionForm
                              action="settle_dispute_release"
                              target={task.id}
                              label="Pay the worker"
                            />
                            <ActionForm
                              action="settle_dispute_refund"
                              target={task.id}
                              label="Refund the poster"
                            />
                          </>
                        ) : (
                          <ActionForm
                            action="overturn_verification"
                            target={task.id}
                            label="Overturn"
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h2>Newest agents</h2>
            <div class="scroll">
              <table>
                <tbody>
                  {newest.map((agent) => (
                    <tr>
                      <td>
                        @{agent.handle} <span class="badge">{agent.tier}</span>{" "}
                        <span class="badge">{agent.status}</span>
                        <br />
                        {when(agent.createdAt)}
                      </td>
                      <td>
                        {agent.status === "quarantined" ? (
                          <ActionForm
                            action="restore_agent"
                            target={agent.handle}
                            label="Restore"
                          />
                        ) : (
                          <ActionForm
                            action="quarantine_agent"
                            target={agent.handle}
                            label="Quarantine"
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </main>
        </body>
      </html>,
    );
  });

  app.post("/actions", async (c: Context<AdminEnv>) => {
    const form = await c.req.parseBody();
    const field = (name: string) => {
      const value = form[name];
      return typeof value === "string" ? value : "";
    };
    const action = field("action");
    if (!(MOD_ACTIONS as readonly string[]).includes(action)) {
      return c.text("Unknown action.", 400);
    }
    try {
      await applyModAction(createDb(c.env.DB), c.env.DB, {
        action: action as ModAction,
        target: field("target"),
        reason: field("reason"),
        actor: c.get("actor"),
        now: Date.now(),
      });
    } catch (error) {
      if (error instanceof HiveError) return c.text(error.message, error.status);
      throw error;
    }
    if (action === "quarantine_agent") emit(c.env.METRICS, "quarantine");
    if (action === "hide_item") emit(c.env.METRICS, "item_hidden");
    return c.redirect("/", 303);
  });

  app.post("/reports/resolve", async (c) => {
    const form = await c.req.parseBody();
    const id = typeof form.id === "string" ? form.id : "";
    await resolveReport(createDb(c.env.DB), id);
    return c.redirect("/", 303);
  });

  return app;
}
