import { type AppLoadContext } from "react-router";
import { type PlatformProxy } from "wrangler";
import { AnalyticsEngineAPI } from "./analytics/query";
import { UnifiedAnalyticsQuery } from "./analytics/unified-query";

interface ExtendedEnv extends Env {
    CF_PAGES_COMMIT_SHA: string;
}

type Cloudflare = Omit<PlatformProxy<ExtendedEnv>, "dispose">;

declare module "react-router" {
    interface AppLoadContext {
        cloudflare: Cloudflare;
        analyticsEngine: AnalyticsEngineAPI;
        unifiedQuery: UnifiedAnalyticsQuery;
        db: D1Database | null;
    }
}

type GetLoadContext = (args: {
    request: Request;
    context: { cloudflare: Cloudflare }; // load context _before_ augmentation
}) => AppLoadContext;

// Shared implementation compatible with Vite, Wrangler, and Cloudflare Pages
export const getLoadContext: GetLoadContext = ({ context }) => {
    const analyticsEngine = new AnalyticsEngineAPI(
        context.cloudflare.env.CF_ACCOUNT_ID,
        context.cloudflare.env.CF_BEARER_TOKEN,
    );

    const db = (context.cloudflare.env as any).ANALYTICS_DB as D1Database | undefined;

    const unifiedQuery = new UnifiedAnalyticsQuery(
        analyticsEngine,
        db ?? null,
    );

    return {
        ...context,
        analyticsEngine: analyticsEngine,
        unifiedQuery: unifiedQuery,
        db: db ?? null,
    };
};

