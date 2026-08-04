const net = require("node:net");

const HTTP_PORT = 3000;
const HEADER_END = "\r\n\r\n";

function parseRequest(rawRequest) {
  const headerEndIndex = rawRequest.indexOf(HEADER_END);

  if (headerEndIndex === -1) {
    throw new Error("Incomplete request");
  }

  const headerSection = rawRequest.slice(0, headerEndIndex);
  const lines = headerSection.split("\r\n");

  const requestLine = lines.shift();
  const [method, path, version] = requestLine.split(" ");

  const headers = {};

  for (const line of lines) {
    if (!line) {
      continue;
    }

    const separatorIndex = line.indexOf(":");

    if (separatorIndex === -1) {
      throw new Error(`Invalid header: ${line}`);
    }

    const name = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1).trim();

    headers[name.toLowerCase()] = value;
  }

  return {
    method,
    path,
    version,
    headers,
  };
}

function createResponse(statusCode, statusText, body) {
  const bodyBuffer = Buffer.from(body, "utf8");

  return [
    `HTTP/1.1 ${statusCode} ${statusText}`,
    "Content-Type: text/plain",
    `Content-Length: ${bodyBuffer.length}`,
    "Connection: close",
    "",
    body,
  ].join("\r\n");
}

function handleRequest(request) {
  if (request.method === "GET" && request.path === "/") {
    return createResponse(200, "OK", "Hello\n");
  }

  if (request.method === "GET" && request.path === "/headers") {
    const body = Object.entries(request.headers)
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n");

    return createResponse(200, "OK", `${body}\n`);
  }

  return createResponse(404, "Not Found", "Not Found\n");
}

function handleConnection(socket) {
  console.log("Client connected");

  let requestBuffer = "";
  let handled = false;

  socket.on("data", (chunk) => {
    if (handled) {
      return;
    }

    requestBuffer += chunk.toString("utf8");

    if (!requestBuffer.includes(HEADER_END)) {
      return;
    }

    handled = true;

    try {
      const request = parseRequest(requestBuffer);

      console.log(request);

      const response = handleRequest(request);

      socket.end(response);
    } catch (error) {
      console.error("Invalid request:", error.message);

      socket.end(createResponse(400, "Bad Request", "Bad Request\n"));
    }
  });

  socket.on("end", () => {
    console.log("Client disconnected");
  });

  socket.on("error", (error) => {
    console.error("Socket error:", error.message);
  });
}

function startServer() {
  const server = net.createServer(handleConnection);

  server.on("error", (error) => {
    console.error("Server error:", error.message);
  });

  server.listen(HTTP_PORT, () => {
    console.log(`Server listening on http://localhost:${HTTP_PORT}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer,
  handleConnection,
};
