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
  }
}

async function drain(): Promise<void> {
  if (draining) {
    return;
  }

  draining = true;

  try {
    while (queue.length > 0) {
      const job = queue.shift();

      if (!job) {
        break;
      }

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
 * Those jobs died with the process, so nothing would ever move them on again
 * and the source would sit showing "processing" indefinitely while the client
 * polls it forever. Marking them FAILED is the honest outcome, and it is
 * preferable to claiming they are still being worked on.
 */
export async function recoverInterruptedIngestions(): Promise<void> {
  try {
    const stranded = [
      ...(await findDocumentsByStatus("PROCESSING")),
      ...(await findDocumentsByStatus("PENDING")),
    ];

    for (const document of stranded) {
      await updateDocumentStatus(document.id, "FAILED");
    }

    if (stranded.length > 0) {
      console.log(
        `Marked ${stranded.length} interrupted ingestion(s) as FAILED`,
      );
    }
  } catch (error) {
    // Never fatal: a server that will not start is worse than a source left
    // showing the wrong status until someone removes it.
    console.error("Could not recover interrupted ingestions:", error);
  }
}