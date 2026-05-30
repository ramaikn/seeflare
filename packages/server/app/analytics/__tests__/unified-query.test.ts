import { describe, expect, test, vi, beforeEach } from "vitest";
import { UnifiedAnalyticsQuery } from "../unified-query";
import { getEarliestDataDate } from "../d1-aggregation";
import { getD1ViewsGroupedByInterval } from "../d1-query";
import { AnalyticsEngineAPI } from "../query";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

dayjs.extend(utc);

vi.mock("../d1-aggregation", () => ({
    getEarliestDataDate: vi.fn(),
}));

vi.mock("../d1-query", () => ({
    getD1ViewsGroupedByInterval: vi.fn(),
    canUseD1ForFilters: () => true,
}));

describe("UnifiedAnalyticsQuery - getViewsGroupedByInterval Padding", () => {
    let mockAnalyticsEngine: any;
    let mockDb: any;
    let query: UnifiedAnalyticsQuery;

    beforeEach(() => {
        vi.clearAllMocks();
        mockAnalyticsEngine = {
            getViewsGroupedByInterval: vi.fn(),
        };
        mockDb = {}; // Dummy D1 database object
        query = new UnifiedAnalyticsQuery(mockAnalyticsEngine as AnalyticsEngineAPI, mockDb);
    });

    test("should pad the beginning of the timeline with 0 values for interval > 90d", async () => {
        // Set current time to 2026-05-31
        const systemTime = new Date("2026-05-31T12:00:00Z");
        vi.useFakeTimers();
        vi.setSystemTime(systemTime);

        // Mock database earliest date to March 1st, 2026
        vi.mocked(getEarliestDataDate).mockResolvedValue("2026-03-01");

        // Mock D1 to return data starting March 1st
        vi.mocked(getD1ViewsGroupedByInterval).mockResolvedValue([
            ["2026-03-01 00:00:00", { views: 5, visitors: 2, bounces: 0 }],
            ["2026-03-02 00:00:00", { views: 8, visitors: 3, bounces: 1 }],
        ]);

        // Mock WAE to return data starting March 3rd (overlapping/more recent)
        mockAnalyticsEngine.getViewsGroupedByInterval.mockResolvedValue([
            ["2026-03-03 00:00:00", { views: 10, visitors: 4, bounces: 0 }],
        ]);

        const startDateTime = dayjs().subtract(120, "day").toDate();
        const endDateTime = systemTime;

        const result = await query.getViewsGroupedByInterval(
            "test-site",
            "DAY",
            startDateTime,
            endDateTime,
            "UTC",
            {},
            "120d",
        );

        // 120d interval means it should cover from 120 days ago to today (inclusive)
        // e.g. Feb 1st, 2026 to May 31st, 2026 (120 days + 1 = 121 entries)
        expect(result.length).toBe(121);

        // Verify start date of the series is padded to Jan 31st
        expect(result[0][0]).toBe("2026-01-31 00:00:00");
        expect(result[0][1]).toEqual({ views: 0, visitors: 0, bounces: 0 });

        // Verify last entry is May 31st
        expect(result[result.length - 1][0]).toBe("2026-05-31 00:00:00");

        // Verify D1 and WAE records are present and merged properly
        const march1Entry = result.find(r => r[0] === "2026-03-01 00:00:00");
        expect(march1Entry).toBeDefined();
        expect(march1Entry![1].views).toBe(5);

        const march3Entry = result.find(r => r[0] === "2026-03-03 00:00:00");
        expect(march3Entry).toBeDefined();
        expect(march3Entry![1].views).toBe(10);

        vi.useRealTimers();
    });

    test("should ensure 'all' interval covers at least 5 years (1825 days) when DB data is recent", async () => {
        const systemTime = new Date("2026-05-31T12:00:00Z");
        vi.useFakeTimers();
        vi.setSystemTime(systemTime);

        // Mock database earliest date to March 1st, 2026 (very recent)
        vi.mocked(getEarliestDataDate).mockResolvedValue("2026-03-01");

        // Mock D1 to return data starting March 1st
        vi.mocked(getD1ViewsGroupedByInterval).mockResolvedValue([
            ["2026-03-01 00:00:00", { views: 5, visitors: 2, bounces: 0 }],
        ]);

        // Mock WAE to return data starting March 3rd
        mockAnalyticsEngine.getViewsGroupedByInterval.mockResolvedValue([
            ["2026-03-03 00:00:00", { views: 10, visitors: 4, bounces: 0 }],
        ]);

        const startDateTime = dayjs().subtract(3650, "day").toDate(); // Passed 10y for "all"
        const endDateTime = systemTime;

        const result = await query.getViewsGroupedByInterval(
            "test-site",
            "MONTH", // "all" uses MONTH
            startDateTime,
            endDateTime,
            "UTC",
            {},
            "all",
        );

        // Five years ago from 2026-05-31 is 2021-06-01
        // Let's verify the first returned month starts 5 years ago (June 2021)
        expect(result[0][0]).toBe("2021-06-01 00:00:00");
        expect(result[0][1]).toEqual({ views: 0, visitors: 0, bounces: 0 });

        // Let's verify total months: 5 years + current partial year (June 2021 to May 2026 = 60 months)
        expect(result.length).toBe(60);

        vi.useRealTimers();
    });
});
