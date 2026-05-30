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

async function main() {
    const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/analytics_engine/sql`;
    const headers = {
        "content-type": "application/json;charset=UTF-8",
        "X-Source": "Cloudflare-Workers",
        "Authorization": `Bearer ${CF_BEARER_TOKEN}`,
    };

    const query = `
        SELECT blob8 as siteId, SUM(_sample_interval) as count
        FROM metricsDataset
        WHERE timestamp >= NOW() - INTERVAL '30' DAY
        GROUP BY siteId
        ORDER BY count DESC
    `;

    const res = await fetch(url, {
        method: "POST",
        headers,
        body: query,
    });

    if (!res.ok) {
        console.error("Error:", res.status, res.statusText);
        console.error(await res.text());
        return;
    }

    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
}

main();
