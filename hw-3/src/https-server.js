const fs = require("node:fs");
const path = require("node:path");
const tls = require("node:tls");

const { handleConnection } = require("./server");

const HTTPS_PORT = 3443;

function startHttpsServer() {
  const keyPath = path.join(
    __dirname,
    "..",
    "certificates",
    "localhost-key.pem",
  );

  const certPath = path.join(
    __dirname,
    "..",
    "certificates",
    "localhost-cert.pem",
  );

  let key;
  let cert;

  try {
    key = fs.readFileSync(keyPath);
    cert = fs.readFileSync(certPath);
  } catch (error) {
    console.error("Failed to read TLS certificate files:", error.message);
    process.exitCode = 1;
    return;
  }

  const server = tls.createServer(
    {
      key,
      cert,
    },
    handleConnection,
  );

  server.on("error", (error) => {
    console.error("HTTPS server error:", error.message);
  });

  server.listen(HTTPS_PORT, () => {
    console.log(`HTTPS server listening on https://localhost:${HTTPS_PORT}`);
  });
}

if (require.main === module) {
  startHttpsServer();
}

module.exports = {
  startHttpsServer,
};
