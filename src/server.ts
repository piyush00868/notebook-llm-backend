import express from "express";
// @ts-expect-error morgan does not ship with TypeScript declarations.
import morgan from "morgan";
import cors from "cors";
import dotenv from "dotenv";
import userRoutes from "./routes/user.routes";
import workspaceRoutes from "./routes/workspace.routes";
import notebookRoutes from "./routes/notebook.routes";
import documentRoutes from "./routes/document.routes";
import { recoverInterruptedIngestions } from "./services/ingestion/ingest.queue";
import { clerkMiddleware } from '@clerk/express'


dotenv.config();

const app = express();

app.use(morgan(":method :url :status :response-time ms"));app.use(cors());
app.use(express.json());
app.use(clerkMiddleware());

app.use("/users", userRoutes);
app.use("/workspaces", workspaceRoutes);
app.use("/notebooks", notebookRoutes);
app.use("/documents", documentRoutes);

const PORT = process.env.PORT || 4000;

app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);

  // Jobs that died with the previous process will never report themselves, so
  // anything left mid-indexing is closed out here. Failure is non-fatal.
  await recoverInterruptedIngestions();
});