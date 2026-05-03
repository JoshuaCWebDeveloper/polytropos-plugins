import { vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.ts";
import { createBrowserRouteContext } from "./server-context.ts";
export const originalFetch = globalThis.fetch;
export function makeState(profile) {
    return {
        // oxlint-disable-next-line typescript/no-explicit-any
        server: null,
        port: 0,
        resolved: {
            enabled: true,
            controlPort: 18791,
            cdpPortRangeStart: 18800,
            cdpPortRangeEnd: 18899,
            cdpProtocol: profile === "remote" ? "https" : "http",
            cdpHost: profile === "remote" ? "browserless.example" : "127.0.0.1",
            cdpIsLoopback: profile !== "remote",
            remoteCdpTimeoutMs: 1500,
            remoteCdpHandshakeTimeoutMs: 3000,
            evaluateEnabled: false,
            extraArgs: [],
            color: "#FF4500",
            headless: true,
            noSandbox: false,
            attachOnly: false,
            ssrfPolicy: { allowPrivateNetwork: true },
            defaultProfile: profile,
            profiles: {
                remote: {
                    cdpUrl: "https://browserless.example/chrome?token=abc",
                    cdpPort: 443,
                    color: "#00AA00",
                },
                openclaw: { cdpPort: 18800, color: "#FF4500" },
            },
        },
        profiles: new Map(),
    };
}
export function makeUnexpectedFetchMock() {
    return vi.fn(async () => {
        throw new Error("unexpected fetch");
    });
}
export function createRemoteRouteHarness(fetchMock) {
    const activeFetchMock = fetchMock ?? makeUnexpectedFetchMock();
    global.fetch = withFetchPreconnect(activeFetchMock);
    const state = makeState("remote");
    const ctx = createBrowserRouteContext({ getState: () => state });
    return { state, remote: ctx.forProfile("remote"), fetchMock: activeFetchMock };
}
export function createSequentialPageLister(responses) {
    return async () => {
        const next = responses.shift();
        if (!next) {
            throw new Error("no more responses");
        }
        return next;
    };
}
export function createJsonListFetchMock(entries) {
    return async (url) => {
        const u = String(url);
        if (!u.includes("/json/list")) {
            throw new Error(`unexpected fetch: ${u}`);
        }
        return {
            ok: true,
            json: async () => entries,
        };
    };
}
function makeManagedTab(id, ordinal) {
    return {
        id,
        title: String(ordinal),
        url: `http://127.0.0.1:300${ordinal}`,
        webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${id}`,
        type: "page",
    };
}
export function makeManagedTabsWithNew(params) {
    const oldTabs = Array.from({ length: 8 }, (_, index) => makeManagedTab(`OLD${index + 1}`, index + 1));
    const newTab = makeManagedTab("NEW", 9);
    return params?.newFirst ? [newTab, ...oldTabs] : [...oldTabs, newTab];
}
//# sourceMappingURL=server-context.remote-tab-ops.harness.js.map