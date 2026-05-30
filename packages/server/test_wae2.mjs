import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load environment variables from .dev.vars if it exists
function loadEnv() {
    try {
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const devVarsPath = path.join(__dirname, '.dev.vars');
        if (fs.existsSync(devVarsPath)) {
            const content = fs.readFileSync(devVarsPath, 'utf8');
            for (const line of content.split(/\r?\n/)) {
                const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
                if (match) {
                    const key = match[1];
                    let val = match[2].trim();
                    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
                    if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
                    process.env[key] = val;
                }
            }
        }
    } catch (e) {
        // ignore
    }
}
loadEnv();

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_BEARER_TOKEN = process.env.CF_BEARER_TOKEN;

if (!CF_ACCOUNT_ID || !CF_BEARER_TOKEN) {
    console.error("Error: CF_ACCOUNT_ID and CF_BEARER_TOKEN environment variables must be set (or configured in packages/server/.dev.vars)");
    process.exit(1);
}

async function queryWAE(query) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/analytics_engine/sql`;
    const headers = {
        "content-type": "application/json;charset=UTF-8",
        "X-Source": "Cloudflare-Workers",
        "Authorization": `Bearer ${CF_BEARER_TOKEN}`,
    };

    const res = await fetch(url, { method: "POST", headers, body: query });
    if (!res.ok) {
        console.error("Error:", res.status, res.statusText);
        console.error(await res.text());
        return null;
    }
    return await res.json();
}

async function main() {
    const siteId = 'resonansipers';

    // Query 1: Stats
    const statsQuery = `
        SELECT SUM(_sample_interval) as count,
            double1 as isVisitor,
            double2 as isBounce
        FROM metricsDataset
        WHERE timestamp >= NOW() - INTERVAL '7' DAY
        AND blob8 = '${siteId}'
        GROUP BY isVisitor, isBounce
    `;

    // Query 2: TimeSeries
    const tsQuery = `
        SELECT SUM(_sample_interval) as count,
            toStartOfInterval(timestamp, INTERVAL '1' DAY, 'Asia/Makassar') as _bucket,
            double1 as isVisitor,
            double2 as isBounce
        FROM metricsDataset
        WHERE timestamp >= NOW() - INTERVAL '7' DAY
        AND blob8 = '${siteId}'
        GROUP BY _bucket, isVisitor, isBounce
    `;

    // Query 3: Paths
    const pathQuery = `
        SELECT blob1 as path, SUM(_sample_interval) as count
        FROM metricsDataset
        WHERE timestamp >= NOW() - INTERVAL '7' DAY
        AND blob8 = '${siteId}'
        GROUP BY path
    `;

    console.log("Stats:", JSON.stringify(await queryWAE(statsQuery), null, 2));
    console.log("TS:", JSON.stringify(await queryWAE(tsQuery), null, 2));
    console.log("Path:", JSON.stringify(await queryWAE(pathQuery), null, 2));
}

main();
