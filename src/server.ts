import express from "express";
// @ts-expect-error morgan does not ship with TypeScript declarations.
import morgan from "morgan";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import dotenv from "dotenv";
import userRoutes from "./routes/user.routes";
import workspaceRoutes from "./routes/workspace.routes";
import notebookRoutes from "./routes/notebook.routes";
import documentRoutes from "./routes/document.routes";
import { recoverInterruptedIngestions } from "./services/ingestion/ingest.queue";
import { clerkMiddleware } from '@clerk/express'

dotenv.config();

const app = express();

// Sentry — only initialise when a DSN is provided
if (process.env.SENTRY_DSN) {
  const Sentry = require("@sentry/node");
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    environment: process.env.NODE_ENV || "production",
  });
}

// Sentry request handler must be the first middleware
if (process.env.SENTRY_DSN) {
  const Sentry = require("@sentry/node");
  app.use(Sentry.Handlers.requestHandler());
}

// Trust proxy (Render sits behind a load balancer)
app.set("trust proxy", 1);

// Health check - no auth required
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Security middleware
app.use(helmet());
app.use(compression());
app.use(morgan(":method :url :status :response-time ms"));

const allowedOrigins = [
  process.env.FRONTEND_URL,
  "https://www.mindor.me",
  "https://mindor.me",
].filter((origin): origin is string => origin !== undefined && origin !== null);

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json());
app.use(clerkMiddleware());

app.use("/users", userRoutes);
app.use("/workspaces", workspaceRoutes);
app.use("/notebooks", notebookRoutes);
app.use("/documents", documentRoutes);

// Sentry error handler must be registered before any other error handler
if (process.env.SENTRY_DSN) {
  const Sentry = require("@sentry/node");
  app.use(Sentry.Handlers.errorHandler());
}

// Global error handler - no stack traces leaked to client
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("UNHANDLED ERROR:", err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 4000;

app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);

  // Jobs that died with the previous process will never report themselves, so
  // anything left mid-indexing is re-enqueued here. Failure is non-fatal.
  await recoverInterruptedIngestions();
});
