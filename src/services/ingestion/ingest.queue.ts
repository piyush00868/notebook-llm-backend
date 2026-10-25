import { createDocumentChunks } from "./chunk.service";
import { indexDocumentChunks } from "../vector/vector.service";
import {
  findDocumentsByStatus,
  updateDocumentStatus,
} from "../document.service";

/**
 * Indexing runs here, after the response has been sent.
 *
 * Extracting text stays in the request, because that is where the useful
 * failures are: a password-protected PDF, a URL that returns nothing, a video
 * with no captions. Those deserve an immediate answer the person uploading
 * actually sees.
 *
 * Chunking and embedding moved out, because that is the slow half and it has
 * nothing to say to the uploader. A long transcript becomes dozens of chunks,
 * each one an embedding call followed by a Pinecone write, so a single upload
 * held a connection open for its whole duration and any gateway timeout in
 * between failed work the database had already accepted. The document row
 * already carries the status for this, so nothing new was needed to express it.
 *
 * The queue is in-process and runs one job at a time: both the embedding
 * provider and Pinecone rate-limit, and serialising keeps a burst of uploads
 * from turning into a burst of 429s. What it does not survive is a restart
 * mid-job, so `recoverInterruptedIngestions` deals with those on startup.
 */

interface IngestJob {
  documentId: number;
}

const queue: IngestJob[] = [];

let draining = false;
let activeJobs = 0;

const CONCURRENT_JOB_LIMIT = 2;

const CRASH_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Indexes one document, recording the outcome on the document itself.
 *
 * Never throws: a failed job must not take the queue down with it, and its
 * failure has to be written somewhere the person uploading can see it.
 */
async function runJob({ documentId }: IngestJob): Promise<void> {
  try {
    await createDocumentChunks(documentId);
    await indexDocumentChunks(documentId);

    await updateDocumentStatus(documentId, "COMPLETED");

    console.log(`INGEST ${documentId} completed`);
  } catch (error) {
    console.error(`INGEST ${documentId} failed:`, error);

    try {
      await updateDocumentStatus(documentId, "FAILED");
    } catch (statusError) {
      console.error(
        `INGEST ${documentId} could not even be marked FAILED:`,
        statusError,
      );
    }
  } finally {
    activeJobs -= 1;
  }
}

async function drain(): Promise<void> {
  if (draining) {
    return;
  }

  draining = true;

  try {
    while (queue.length > 0) {
      // Wait for a concurrency slot if we're at the limit
      while (activeJobs >= CONCURRENT_JOB_LIMIT) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      const job = queue.shift();

      if (!job) {
        break;
      }

      activeJobs += 1;
      await runJob(job);
    }
  } finally {
    draining = false;
  }
}

/**
 * Queues a document for indexing.
 *
 * Returns immediately. Deliberately not awaited by callers: the HTTP response
 * is already on its way, and awaiting here would put the work straight back on
 * the request path.
 */
export function enqueueIngestion(documentId: number): void {
  queue.push({ documentId });

  void drain().catch((error) => {
    console.error("Ingestion queue stopped:", error);
  });
}

/**
 * Closes out documents that were mid-indexing when the process last stopped.
 *
 * Documents left in PROCESSING or PENDING are re-enqueued instead of being
 * marked FAILED, because chunking and embedding are idempotent: re-running
 * them produces the same vectors. Documents younger than 2 minutes are left
 * alone — they might still be processed by a previous instance during a
 * deploy. Documents older than 2 minutes are re-enqueued because they may
 * have been stranded by a crashed instance.
 */
export async function recoverInterruptedIngestions(): Promise<void> {
  try {
    const stranded = [
      ...(await findDocumentsByStatus("PROCESSING")),
      ...(await findDocumentsByStatus("PENDING")),
    ];

    const now = Date.now();

    for (const document of stranded) {
      const age = now - new Date(document.createdAt).getTime();

      // Documents younger than 2 minutes might still be processed by the old
      // instance during a deploy. Only re-enqueue older documents.
      if (age < CRASH_WINDOW_MS) {
        continue;
      }

      queue.push({ documentId: document.id });
    }

    if (queue.length > 0) {
      console.log(
        `Re-enqueued ${queue.length} interrupted ingestion(s) for processing`,
      );
    }

    // Kick off draining for any re-enqueued jobs
    void drain().catch((error) => {
      console.error("Ingestion queue restart failed:", error);
    });
  } catch (error) {
    // Never fatal: a server that will not start is worse than a source left
    // showing the wrong status until someone removes it.
    console.error("Could not recover interrupted ingestions:", error);
  }
}
