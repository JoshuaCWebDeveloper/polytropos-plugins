import { createServer } from "node:http";
export async function getFreePort() {
    while (true) {
        const port = await new Promise((resolve, reject) => {
            const s = createServer();
            s.once("error", reject);
            s.listen(0, "127.0.0.1", () => {
                const assigned = s.address().port;
                s.close((err) => (err ? reject(err) : resolve(assigned)));
            });
        });
        if (port < 65535) {
            return port;
        }
    }
}
//# sourceMappingURL=test-port.js.map