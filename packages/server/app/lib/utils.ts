import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export function paramsFromUrl(url: string) {
    const searchParams = new URL(url).searchParams;
    const params: Record<string, string> = {};
    searchParams.forEach((value, key) => {
        params[key] = value;
    });
    return params;
}

interface SearchFilters {
    path?: string;
    referrer?: string;
    deviceType?: string;
    country?: string;
    browserName?: string;
    browserVersion?: string;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmTerm?: string;
    utmContent?: string;
}

export function getFiltersFromSearchParams(searchParams: URLSearchParams) {
    const filters: SearchFilters = {};

    if (searchParams.has("path")) {
        filters.path = searchParams.get("path") || "";
    }
    if (searchParams.has("referrer")) {
        filters.referrer = searchParams.get("referrer") || "";
    }
    if (searchParams.has("deviceType")) {
        filters.deviceType = searchParams.get("deviceType") || "";
    }
    if (searchParams.has("country")) {
        filters.country = searchParams.get("country") || "";
    }
    if (searchParams.has("browserName")) {
        filters.browserName = searchParams.get("browserName") || "";
    }
    if (searchParams.has("browserVersion")) {
        filters.browserVersion = searchParams.get("browserVersion") || "";
    }
    if (searchParams.has("utmSource")) {
        filters.utmSource = searchParams.get("utmSource") || "";
    }
    if (searchParams.has("utmMedium")) {
        filters.utmMedium = searchParams.get("utmMedium") || "";
    }
    if (searchParams.has("utmCampaign")) {
        filters.utmCampaign = searchParams.get("utmCampaign") || "";
    }
    if (searchParams.has("utmTerm")) {
        filters.utmTerm = searchParams.get("utmTerm") || "";
    }
    if (searchParams.has("utmContent")) {
        filters.utmContent = searchParams.get("utmContent") || "";
    }

    return filters;
}

export function getUserTimezone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
        // Fallback to UTC if browser doesn't support Intl API
        return "UTC";
    }
}

export function getIntervalType(interval: string): "DAY" | "HOUR" {
    switch (interval) {
        case "today":
        case "yesterday":
        case "1d":
            return "HOUR";
        case "7d":
        case "30d":
        case "90d":
        case "120d":
        case "365d":
        case "1095d":
        case "1825d":
        case "all":
            return "DAY";
        default:
            return "DAY";
    }
}

/**
 * Returns true if the given interval exceeds WAE's 90-day retention
 * and requires D1 historical data.
 */
export function isExtendedInterval(interval: string): boolean {
    if (interval === "all") return true;
    const match = interval.match(/^(\d+)d$/);
    if (!match) return false;
    return parseInt(match[1], 10) > 90;
}

export function getDateTimeRange(interval: string, tz: string) {
    let localDateTime = dayjs().utc();
    let localEndDateTime: dayjs.Dayjs | undefined;

    if (interval === "today") {
        localDateTime = localDateTime.tz(tz).startOf("day");
    } else if (interval === "yesterday") {
        localDateTime = localDateTime.tz(tz).startOf("day").subtract(1, "day");
        localEndDateTime = localDateTime.endOf("day").add(2, "ms");
    } else if (interval === "all") {
        // For "all", go back a very large number of days.
        // The unified query layer will dynamically determine the actual earliest date.
        localDateTime = localDateTime
            .subtract(3650, "day") // ~10 years as a safe upper bound
            .tz(tz)
            .startOf("day");
    } else {
        const daysAgo = Number(interval.split("d")[0]);
        const intervalType = getIntervalType(interval);

        if (intervalType === "DAY") {
            localDateTime = localDateTime
                .subtract(daysAgo, "day")
                .tz(tz)
                .startOf("day");
        } else if (intervalType === "HOUR") {
            localDateTime = localDateTime
                .subtract(daysAgo, "day")
                .startOf("hour");
        }
    }

    if (!localEndDateTime) {
        localEndDateTime = dayjs().utc().tz(tz);
    }

    return {
        startDate: localDateTime.toDate(),
        endDate: localEndDateTime.toDate(),
    };
}

export function maskBrowserVersion(version?: string) {
    if (!version) return version;

    const majorEnd = version.indexOf(".");

    if (majorEnd != -1) {
        version =
            version.substring(0, majorEnd) +
            version.slice(majorEnd).replaceAll(/\.[^.]+/g, ".x");
    }

    return version;
}
