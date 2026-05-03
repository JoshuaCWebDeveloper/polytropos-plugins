import { vi } from "vitest";
export const connectOverCdpMock = vi.fn();
export const getChromeWebSocketUrlMock = vi.fn();
vi.mock("playwright-core", () => ({
    chromium: {
        connectOverCDP: (...args) => connectOverCdpMock(...args),
    },
}));
vi.mock("./chrome.js", () => ({
    getChromeWebSocketUrl: (...args) => getChromeWebSocketUrlMock(...args),
}));
//# sourceMappingURL=pw-session.mock-setup.js.map