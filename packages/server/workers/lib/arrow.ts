import { AnalyticsEngineAPI } from "../../app/analytics/query";
import { ColumnMappings } from "../../app/analytics/schema";
import { tableFromJSON, tableToIPC } from "apache-arrow";
import dayjs from "dayjs";

export async function extractAsArrow(
    { accountId, bearerToken }: { accountId: string; bearerToken: string },
    bucket: R2Bucket,
) {
    const api = new AnalyticsEngineAPI(accountId, bearerToken);

    // Get yesterday's date range
    const yesterday = dayjs().subtract(1, "day");
    const startDateTime = yesterday.startOf("day").toDate();
    const endDateTime = yesterday.endOf("day").toDate();

    // Dimension columns to extract. Excludes high-cardinality fields that would
    // cause cross-product explosion in a single GROUP BY query.
    // Mirrors the filter used in d1-aggregation.ts aggregateDay().
    const columns = Object.keys(ColumnMappings).filter(
        (key) =>
            key !== "siteId" &&
            key !== "newVisitor" &&
            key !== "bounce" &&
            key !== "newSession" &&
            key !== "host" &&
            key !== "userAgent",
    ) as (keyof typeof ColumnMappings)[];

    // Use range interval to discover active sites for yesterday
    const rangeInterval = `range:${startDateTime.toISOString()}|${endDateTime.toISOString()}`;
    const sites = await api.getSitesOrderedByHits(rangeInterval, 100);
    const siteIds = sites.map((s) => s[0]);

    // Query each dimension column per site SEPARATELY to avoid the WAE row-limit
    // cross-product truncation that occurs when grouping all columns simultaneously.
    const records: any[] = [];
    const dateStr = yesterday.format("YYYY-MM-DD");

    for (const siteId of siteIds) {
        for (const col of columns) {
            const countsMap = await api.getAggregationCountsForColumn(
                siteId,
                col,
                startDateTime,
                endDateTime,
            );
            for (const [val, counts] of Object.entries(countsMap)) {
                records.push({
                    date: dateStr,
                    siteId,
                    dimensionType: col,
                    dimensionValue: val,
                    views: counts.views,
                    visitors: counts.visitors,
                    bounces: counts.bounces,
                });
            }
        }
    }

    // Create Arrow table from JSON records
    const table = tableFromJSON(records);

    // Convert to Arrow IPC buffer
    const arrowBuffer = new Uint8Array(tableToIPC(table, "file"));

    // Generate filename with yesterday's date
    const filename = `analytics-${yesterday.format("YYYY-MM-DD")}.arrow`;

    // Save to R2
    await bucket.put(filename, arrowBuffer);

    console.log(`Saved ${records.length} records to ${filename}`);

    return { filename, recordCount: records.length };
}

// IIFE for testing
if (import.meta.url === `file://${process.argv[1]}`) {
    (async () => {
        // Mock R2 bucket for local testing
        const mockBucket = {
            put: async (filename: string, data: Uint8Array) => {
                console.log(
                    `Mock: Would save ${data.length} bytes to ${filename}`,
                );
                return {
                    key: filename,
                    version: "mock",
                    size: data.length,
                    etag: "mock",
                    httpEtag: "mock",
                    uploaded: new Date(),
                    checksums: { md5: "mock", sha1: "mock", sha256: "mock" },
                    storageClass: "STANDARD",
                    writeHttpMetadata: {},
                };
            },
            head: async () => null,
            get: async () => null,
            delete: async () => {},
            createMultipartUpload: async () => ({
                uploadId: "mock",
                key: "mock",
                uploadPart: async () => ({ partNumber: 1, etag: "mock" }),
                abort: async () => {},
                complete: async () => ({
                    key: "mock",
                    version: "mock",
                    size: 0,
                    etag: "mock",
                    httpEtag: "mock",
                    uploaded: new Date(),
                    checksums: { md5: "mock", sha1: "mock", sha256: "mock" },
                    storageClass: "STANDARD",
                    writeHttpMetadata: {},
                }),
            }),
            resumeMultipartUpload: async () => ({
                uploadId: "mock",
                key: "mock",
                uploadPart: async () => ({ partNumber: 1, etag: "mock" }),
                abort: async () => {},
                complete: async () => ({
                    key: "mock",
                    version: "mock",
                    size: 0,
                    etag: "mock",
                    httpEtag: "mock",
                    uploaded: new Date(),
                    checksums: { md5: "mock", sha1: "mock", sha256: "mock" },
                    storageClass: "STANDARD",
                    writeHttpMetadata: {},
                }),
            }),
            list: async () => ({
                objects: [],
                delimitedPrefixes: [],
                truncated: false,
            }),
        } as unknown as R2Bucket;

        // Get credentials from environment variables
        const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
        const bearerToken = process.env.CLOUDFLARE_API_TOKEN;

        if (!accountId || !bearerToken) {
            console.error(
                "Error: Please set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN environment variables",
            );
            process.exit(1);
        }

        try {
            const result = await extractAsArrow(
                { accountId, bearerToken },
                mockBucket,
            );
            console.log("Success:", result);
        } catch (error) {
            console.error("Error:", error);
            process.exit(1);
        }
    })();
}
