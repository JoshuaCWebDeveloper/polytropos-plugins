import { beforeEach, vi } from "vitest";
let currentPage = null;
let currentRefLocator = null;
let pageState = {
    console: [],
    armIdUpload: 0,
    armIdDialog: 0,
    armIdDownload: 0,
};
const sessionMocks = vi.hoisted(() => ({
    getPageForTargetId: vi.fn(async () => {
        if (!currentPage) {
            throw new Error("missing page");
        }
        return currentPage;
    }),
    ensurePageState: vi.fn(() => pageState),
    forceDisconnectPlaywrightForTarget: vi.fn(async () => { }),
    restoreRoleRefsForTarget: vi.fn(() => { }),
    storeRoleRefsForTarget: vi.fn(() => { }),
    refLocator: vi.fn(() => {
        if (!currentRefLocator) {
            throw new Error("missing locator");
        }
        return currentRefLocator;
    }),
    rememberRoleRefsForTarget: vi.fn(() => { }),
}));
vi.mock("./pw-session.js", () => sessionMocks);
export function getPwToolsCoreSessionMocks() {
    return sessionMocks;
}
export function setPwToolsCoreCurrentPage(page) {
    currentPage = page;
}
export function setPwToolsCoreCurrentRefLocator(locator) {
    currentRefLocator = locator;
}
export function installPwToolsCoreTestHooks() {
    beforeEach(() => {
        currentPage = null;
        currentRefLocator = null;
        pageState = {
            console: [],
            armIdUpload: 0,
            armIdDialog: 0,
            armIdDownload: 0,
        };
        for (const fn of Object.values(sessionMocks)) {
            fn.mockClear();
        }
    });
}
//# sourceMappingURL=pw-tools-core.test-harness.js.map