import type { 
    ExecutionContext,
    ExportedHandler,
    ScheduledController,
} from "@cloudflare/workers-types";
import { createRequestHandler, type ServerBuild } from "react-router";

/**
 * NOTE: Must use relative paths inside this file (no ~ shorthand), because
 * it gets packaged into Worker and special paths defined in tsconfig will not
 * resolve.
 */
import { getLoadContext } from "../app/load-context";
import * as build from "../build/server";
import { extractAsArrow } from "./lib/arrow";
import { runDailyAggregation } from "../app/analytics/d1-aggregation";
import { AnalyticsEngineAPI } from "../app/analytics/query";

const requestHandler = createRequestHandler(build as unknown as ServerBuild);

export default {
    async scheduled(
        _controller: ScheduledController,
        env: Env,
        ctx: ExecutionContext,
    ) {
        if (env.CF_STORAGE_ENABLED === "false") return;

        // BUG #13 FIX: Run R2 backup and D1 aggregation sequentially (not concurrently).
        // On first run, D1 backfill reads R2 files — they must exist before aggregation starts.
        ctx.waitUntil(
            (async () => {
                // Step 1: Arrow R2 backup
                try {
                    await extractAsArrow(
                        {
                            accountId: env.CF_ACCOUNT_ID,
                            bearerToken: env.CF_BEARER_TOKEN,
                        },
                        env.DAILY_ROLLUPS,
                    );
                } catch (arrowErr) {
                    // Non-fatal: log and continue to D1 aggregation
                    console.error("Arrow backup error:", arrowErr);
                }

                // Step 2: D1 aggregation + compaction (only if ANALYTICS_DB is configured)
                if ((env as any).ANALYTICS_DB) {
                    try {
                        const api = new AnalyticsEngineAPI(
                            env.CF_ACCOUNT_ID,
                            env.CF_BEARER_TOKEN,
                        );

                        // Run aggregation + compaction
                        const compactionDaysStr = (env as any).CF_D1_COMPACTION_DAYS;
                        const compactionDays = compactionDaysStr
                            ? parseInt(compactionDaysStr as string, 10)
                            : undefined;

                        await runDailyAggregation(
                            (env as any).ANALYTICS_DB,
                            api,
                            env.DAILY_ROLLUPS,
                            compactionDays,
                        );

                        // BUG #10 FIX: Delete R2 Arrow files older than 95 days.
                        // 95 days = 5-day safety buffer beyond WAE's 90-day retention.
                        // After D1 aggregation, older R2 files are permanently redundant.
                        try {
                            const cutoffDate = new Date();
                            cutoffDate.setDate(cutoffDate.getDate() - 95);
                            const objects = await env.DAILY_ROLLUPS.list({ limit: 1000 });
                            for (const obj of objects.objects) {
                                const match = obj.key.match(
                                    /analytics-(\d{4}-\d{2}-\d{2})\.arrow/,
                                );
                                if (match) {
                                    const fileDate = new Date(match[1]);
                                    if (fileDate < cutoffDate) {
                                        await env.DAILY_ROLLUPS.delete(obj.key);
                                        console.log(`Deleted old R2 backup: ${obj.key}`);
                                    }
                                }
                            }
                        } catch (cleanupErr) {
                            // Non-fatal: log and continue
                            console.error("R2 cleanup error:", cleanupErr);
                        }

                    } catch (aggError) {
                        console.error("Aggregation error:", aggError);
                    }
                }
            })(),
        );
    },
    // @ts-expect-error TODO figure out types here
    async fetch(request: any, env: any, ctx: any) {
        try {
            const loadContext = getLoadContext({
                request,
                context: {
                    cloudflare: {
                        ctx: {
                            waitUntil: ctx.waitUntil.bind(ctx),
                            passThroughOnException:
                                ctx.passThroughOnException.bind(ctx),
                            props: ctx.props,
                        },
                        cf: request.cf as never,
                        // @ts-expect-error TODO: figure out how to get this type to work
                        caches,
                        env,
                    },
                },
            });
            return await requestHandler(request, loadContext);
        } catch (error) {
            console.log(error);
            return new Response("An unexpected error occurred", {
                status: 500,
            });
        }
    },
} satisfies ExportedHandler<Env>;
