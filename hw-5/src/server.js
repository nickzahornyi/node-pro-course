import express from "express";
import pg from "pg";

const { Pool } = pg;

const port = Number(process.env.PORT ?? 3000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();

app.get("/health", async (_request, response) => {
  try {
    await pool.query("SELECT 1");
    response.status(200).json({ status: "ok" });
  } catch {
    response.status(503).json({ status: "error", database: "unavailable" });
  }
});

app.get("/users", async (_request, response, next) => {
  try {
    const result = await pool.query(
      "SELECT id, name, email FROM users ORDER BY id",
    );
    response.json(result.rows);
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: "Internal server error" });
});

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`API listening on port ${port}`);
});

const shutdown = () => {
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
