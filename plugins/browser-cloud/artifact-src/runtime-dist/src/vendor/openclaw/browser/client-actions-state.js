import { buildProfileQuery, withBaseUrl } from "./client-actions-url.ts";
import { fetchBrowserJson } from "./client-fetch.ts";
function buildStateQuery(params) {
    const query = new URLSearchParams();
    if (params.targetId) {
        query.set("targetId", params.targetId);
    }
    if (params.key) {
        query.set("key", params.key);
    }
    if (params.profile) {
        query.set("profile", params.profile);
    }
    const suffix = query.toString();
    return suffix ? `?${suffix}` : "";
}
async function postProfileJson(baseUrl, params) {
    const query = buildProfileQuery(params.profile);
    return await fetchBrowserJson(withBaseUrl(baseUrl, `${params.path}${query}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params.body),
        timeoutMs: 20000,
    });
}
async function postTargetedProfileJson(baseUrl, params) {
    return await postProfileJson(baseUrl, {
        path: params.path,
        profile: params.opts.profile,
        body: {
            targetId: params.opts.targetId,
            ...params.body,
        },
    });
}
export async function browserCookies(baseUrl, opts = {}) {
    const suffix = buildStateQuery({ targetId: opts.targetId, profile: opts.profile });
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/cookies${suffix}`), { timeoutMs: 20000 });
}
export async function browserCookiesSet(baseUrl, opts) {
    return await postProfileJson(baseUrl, {
        path: "/cookies/set",
        profile: opts.profile,
        body: { targetId: opts.targetId, cookie: opts.cookie },
    });
}
export async function browserCookiesClear(baseUrl, opts = {}) {
    return await postProfileJson(baseUrl, {
        path: "/cookies/clear",
        profile: opts.profile,
        body: { targetId: opts.targetId },
    });
}
export async function browserStorageGet(baseUrl, opts) {
    const suffix = buildStateQuery({ targetId: opts.targetId, key: opts.key, profile: opts.profile });
    return await fetchBrowserJson(withBaseUrl(baseUrl, `/storage/${opts.kind}${suffix}`), { timeoutMs: 20000 });
}
export async function browserStorageSet(baseUrl, opts) {
    return await postProfileJson(baseUrl, {
        path: `/storage/${opts.kind}/set`,
        profile: opts.profile,
        body: {
            targetId: opts.targetId,
            key: opts.key,
            value: opts.value,
        },
    });
}
export async function browserStorageClear(baseUrl, opts) {
    return await postProfileJson(baseUrl, {
        path: `/storage/${opts.kind}/clear`,
        profile: opts.profile,
        body: { targetId: opts.targetId },
    });
}
export async function browserSetOffline(baseUrl, opts) {
    return await postProfileJson(baseUrl, {
        path: "/set/offline",
        profile: opts.profile,
        body: { targetId: opts.targetId, offline: opts.offline },
    });
}
export async function browserSetHeaders(baseUrl, opts) {
    return await postProfileJson(baseUrl, {
        path: "/set/headers",
        profile: opts.profile,
        body: { targetId: opts.targetId, headers: opts.headers },
    });
}
export async function browserSetHttpCredentials(baseUrl, opts = {}) {
    return await postTargetedProfileJson(baseUrl, {
        path: "/set/credentials",
        opts,
        body: {
            username: opts.username,
            password: opts.password,
            clear: opts.clear,
        },
    });
}
export async function browserSetGeolocation(baseUrl, opts = {}) {
    return await postTargetedProfileJson(baseUrl, {
        path: "/set/geolocation",
        opts,
        body: {
            latitude: opts.latitude,
            longitude: opts.longitude,
            accuracy: opts.accuracy,
            origin: opts.origin,
            clear: opts.clear,
        },
    });
}
export async function browserSetMedia(baseUrl, opts) {
    return await postProfileJson(baseUrl, {
        path: "/set/media",
        profile: opts.profile,
        body: {
            targetId: opts.targetId,
            colorScheme: opts.colorScheme,
        },
    });
}
export async function browserSetTimezone(baseUrl, opts) {
    return await postProfileJson(baseUrl, {
        path: "/set/timezone",
        profile: opts.profile,
        body: {
            targetId: opts.targetId,
            timezoneId: opts.timezoneId,
        },
    });
}
export async function browserSetLocale(baseUrl, opts) {
    return await postProfileJson(baseUrl, {
        path: "/set/locale",
        profile: opts.profile,
        body: { targetId: opts.targetId, locale: opts.locale },
    });
}
export async function browserSetDevice(baseUrl, opts) {
    return await postProfileJson(baseUrl, {
        path: "/set/device",
        profile: opts.profile,
        body: { targetId: opts.targetId, name: opts.name },
    });
}
export async function browserClearPermissions(baseUrl, opts = {}) {
    return await postProfileJson(baseUrl, {
        path: "/set/geolocation",
        profile: opts.profile,
        body: { targetId: opts.targetId, clear: true },
    });
}
//# sourceMappingURL=client-actions-state.js.map