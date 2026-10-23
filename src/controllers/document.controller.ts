import type { Request} from "express";
import type { Response } from "express";
import { z } from "zod";
import { getAuth } from "@clerk/express";
import { getNotebookById } from "../services/notebook.service";
import { extractPdfText } from "../services/ingestion/pdf.service";
import { extractUrlText } from "../services/ingestion/url.service";
import { enqueueIngestion } from "../services/ingestion/ingest.queue";
import { extractYoutubeTranscript, describeTranscriptFailure } from "../services/ingestion/youtube.service";
import { assertOwner } from "../services/authorization.service";
import {
  createDocument,
  getDocumentById,
  deleteDocument,
} from "../services/document.service";

const createDocumentSchema = z.object({
  title: z.string().min(1),
  sourceType: z.enum(["PDF", "WEB", "YOUTUBE", "TEXT"]),
  sourceUrl: z.string().url().optional(),
  storageKey: z.string().min(1).optional(),
  content: z.string().optional(),
  status: z.enum(["PENDING", "PROCESSING", "COMPLETED", "FAILED"]),
  notebookId: z.number().int().positive(),
}).superRefine((data, ctx) => {
  if (data.sourceType === "TEXT" && !data.content?.trim()) {
    ctx.addIssue({
      code: "custom",
      path: ["content"],
      message: "Content is required for TEXT documents",
    });
  }
}); 
export async function createDocumentController(
  req: Request,
  res: Response,
) {
  try {
    const { userId } = getAuth(req);

    if (!userId) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    const result = createDocumentSchema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: "Invalid request data",
        details: result.error,
      });
    }

    const notebook = await getNotebookById(result.data.notebookId);

    if (!notebook) {
      return res.status(404).json({
        error: "Notebook not found",
      });
    }

    if (!notebook.workspace) {
      return res.status(500).json({
        error: "Notebook workspace not found",
      });
    }
    

try {

  assertOwner(notebook.workspace.owner.clerkUserId, userId);
} catch {
  return res.status(403).json({
    error: "Forbidden",
  });
}

    const document = await createDocument(result.data);

    return res.status(201).json(document);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Failed to create document",
    });
  }
}

export async function getDocumentController(req: Request, res: Response) {

  const { userId } = getAuth(req);

if (!userId) {
  return res.status(401).json({
    error: "Unauthorized",
  });
}
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        error: "Invalid document id",
      });
    }

    const document = await getDocumentById(id);

    if (!document) {
      return res.status(404).json({
        error: "Document not found",
      });
    }
    if (!document.notebook) {
  return res.status(500).json({
    error: "Document notebook not found",
  });
}

if (!document.notebook.workspace) {
  return res.status(500).json({
    error: "Document workspace not found",
  });
}

try {
  assertOwner(document.notebook.workspace.owner.clerkUserId, userId);
} catch {
  return res.status(403).json({
    error: "Forbidden",
  });
}
    return res.status(200).json(document);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Failed to get document",
    });
  }
}

export async function deleteDocumentController(
  req: Request,
  res: Response,
) {
  const { userId } = getAuth(req);

  if (!userId) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        error: "Invalid document id",
      });
    }

    const document = await getDocumentById(id);

    if (!document) {
      return res.status(404).json({
        error: "Document not found",
      });
    }

    if (!document.notebook) {
      return res.status(500).json({
        error: "Document notebook not found",
      });
    }

    if (!document.notebook.workspace) {
      return res.status(500).json({
        error: "Document workspace not found",
      });
    }

    try {
      assertOwner(
        document.notebook.workspace.owner.clerkUserId,
        userId,
      );
    } catch {
      return res.status(403).json({
        error: "Forbidden",
      });
    }

    await deleteDocument(id);

    return res.status(204).send();
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Failed to delete document",
    });
  }
}

export async function uploadPdfController(
  req: Request,
  res: Response,
) {
  const { userId } = getAuth(req);

  if (!userId) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  try {
    if (!req.file) {
      return res.status(400).json({
        error: "PDF file is required",
      });
    }

    const notebookId = Number(req.body.notebookId);
    const title = String(req.body.title ?? "").trim();

    if (!Number.isInteger(notebookId) || notebookId <= 0) {
      return res.status(400).json({
        error: "Invalid notebookId",
      });
    }

    if (!title) {
      return res.status(400).json({
        error: "Title is required",
      });
    }

    const notebook = await getNotebookById(notebookId);

    if (!notebook) {
      return res.status(404).json({
        error: "Notebook not found",
      });
    }

    if (!notebook.workspace) {
      return res.status(500).json({
        error: "Notebook workspace not found",
      });
    }

    try {
      assertOwner(
        notebook.workspace.owner.clerkUserId,
        userId,
      );
    } catch {
      return res.status(403).json({
        error: "Forbidden",
      });
    }

    const extracted = await extractPdfText(req.file.buffer);

    /*
     * Release the uploaded PDF as soon as text extraction finishes.
     *
     * `multer.memoryStorage` keeps the whole upload referenced by `req.file`
     * for the lifetime of the request, so it would otherwise sit alongside the
     * extracted text, the chunk array and the embedding batches all at once.
     * Nothing downstream reads it.
     */
    req.file.buffer = Buffer.alloc(0);

    if (!extracted.trim()) {
      return res.status(400).json({
        error: "Could not extract text from PDF",
      });
    }

    /*
     * Normalisation happens once, inside `createDocument`. Doing it here as
     * well meant every ingestion path ran the full replace chain twice over
     * the whole document, doubling peak allocation for no behavioural gain.
     */
    const document = await createDocument({
      title,
      sourceType: "PDF",
      content: extracted,
      status: "PROCESSING",
      notebookId,
    });
    /*
     * Chunking and embedding continue after this response. The upload has
     * already been accepted and stored, so the source appears immediately
     * and settles to COMPLETED or FAILED on its own -- which the client
     * already polls for.
     */
    enqueueIngestion(document.id);

    return res.status(201).json({
      message: "PDF uploaded and queued for indexing",
      document,
    });

  } catch (error) {
    console.error("PDF INGESTION ERROR:", error);

    if (
      error instanceof Error &&
      error.name === "PasswordException"
    ) {
      return res.status(400).json({
        error: "Password-protected PDFs are not supported",
      });
    }

    return res.status(500).json({
      error: "Failed to ingest PDF",
    });
  }
}


export async function uploadUrlController(
  req: Request,
  res: Response,
) {
  const { userId } = getAuth(req);

  if (!userId) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  try {
    const notebookId = Number(req.body.notebookId);
    const title = String(req.body.title ?? "").trim();
    const url = String(req.body.url ?? "").trim();

    if (!Number.isInteger(notebookId) || notebookId <= 0) {
      return res.status(400).json({
        error: "Invalid notebookId",
      });
    }

    if (!title) {
      return res.status(400).json({
        error: "Title is required",
      });
    }

    if (!url) {
      return res.status(400).json({
        error: "URL is required",
      });
    }

    const notebook = await getNotebookById(notebookId);

    if (!notebook) {
      return res.status(404).json({
        error: "Notebook not found",
      });
    }

    if (!notebook.workspace) {
      return res.status(500).json({
        error: "Notebook workspace not found",
      });
    }

    try {
      assertOwner(
        notebook.workspace.owner.clerkUserId,
        userId,
      );
    } catch {
      return res.status(403).json({
        error: "Forbidden",
      });
    }

    const extracted = await extractUrlText(url);

    if (!extracted.content.trim()) {
      return res.status(400).json({
        error: "Could not extract text from URL",
      });
    }

    const document = await createDocument({
      title,
      sourceType: "URL",
      sourceUrl: url,
      content: extracted.content,
      status: "PROCESSING",
      notebookId,
    });

    enqueueIngestion(document.id);

    /*
     * Reports PROCESSING rather than COMPLETED, because it is: indexing
     * continues after this response and the client polls until it settles.
     */
    return res.status(201).json(document);
  } catch (error) {
    console.error("URL INGESTION ERROR:", error);

    return res.status(500).json({
      error: "Failed to ingest URL",
    });
  }
}

export async function uploadYoutubeController(
  req: Request,
  res: Response,
) {
  const { userId } = getAuth(req);

  if (!userId) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  try {
    const notebookId = Number(req.body.notebookId);
    const title = String(req.body.title ?? "").trim();
    const url = String(req.body.url ?? "").trim();

    if (!Number.isInteger(notebookId) || notebookId <= 0) {
      return res.status(400).json({
        error: "Invalid notebookId",
      });
    }

    if (!title) {
      return res.status(400).json({
        error: "Title is required",
      });
    }

    if (!url) {
      return res.status(400).json({
        error: "YouTube URL is required",
      });
    }

    const notebook = await getNotebookById(notebookId);

    if (!notebook) {
      return res.status(404).json({
        error: "Notebook not found",
      });
    }

    if (!notebook.workspace) {
      return res.status(500).json({
        error: "Notebook workspace not found",
      });
    }

    try {
      assertOwner(
        notebook.workspace.owner.clerkUserId,
        userId,
      );
    } catch {
      return res.status(403).json({
        error: "Forbidden",
      });
    }

    const transcript = await extractYoutubeTranscript(url);

    if (!transcript.content.trim()) {
      return res.status(400).json({
        error: "Could not extract YouTube transcript",
      });
    }

    const document = await createDocument({
      title,
      sourceType: "YOUTUBE",
      sourceUrl: url,
      content: transcript.content,
      status: "PROCESSING",
      notebookId,
    });

    enqueueIngestion(document.id);

    /*
     * Reports PROCESSING rather than COMPLETED, because it is: indexing
     * continues after this response and the client polls until it settles.
     */
    return res.status(201).json(document);
  } catch (error) {
    /*
     * A video we cannot read a transcript from is not a server fault, so the
     * specific reason is reported instead of a blanket 500. `null` means the
     * failure was not one we recognise, which is the only case logged.
     */
    const failure = describeTranscriptFailure(error);

    if (failure) {
      return res.status(failure.status).json({ error: failure.error });
    }

    console.error("YOUTUBE INGESTION ERROR:", error);

    return res.status(500).json({
      error: "Failed to ingest YouTube video",
    });
  }
}

/**
 * Pasted text.
 *
 * Mirrors the URL and YouTube controllers: store the normalised text, then
 * queue it for chunking and indexing.
 *
 * Indexing is what makes a source reachable. A document whose chunks carry no
 * vector in Pinecone can never be surfaced by a question, so it would sit in
 * the notebook permanently invisible -- which is why the queue, rather than
 * this handler, is what decides the source is usable.
 */
export async function uploadTextController(
  req: Request,
  res: Response,
) {
  const { userId } = getAuth(req);

  if (!userId) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  try {
    const notebookId = Number(req.body.notebookId);
    const title = String(req.body.title ?? "").trim();
    const rawContent = String(req.body.content ?? "");

    if (!Number.isInteger(notebookId) || notebookId <= 0) {
      return res.status(400).json({
        error: "Invalid notebookId",
      });
    }

    if (!title) {
      return res.status(400).json({
        error: "Title is required",
      });
    }

    if (!rawContent.trim()) {
      return res.status(400).json({
        error: "Text is required",
      });
    }

    const notebook = await getNotebookById(notebookId);

    if (!notebook) {
      return res.status(404).json({
        error: "Notebook not found",
      });
    }

    if (!notebook.workspace) {
      return res.status(500).json({
        error: "Notebook workspace not found",
      });
    }

    try {
      assertOwner(
        notebook.workspace.owner.clerkUserId,
        userId,
      );
    } catch {
      return res.status(403).json({
        error: "Forbidden",
      });
    }

    const document = await createDocument({
      title,
      sourceType: "TEXT",
      content: rawContent,
      status: "PROCESSING",
      notebookId,
    });

    enqueueIngestion(document.id);

    /*
     * Reports PROCESSING rather than COMPLETED, because it is: indexing
     * continues after this response and the client polls until it settles.
     */
    return res.status(201).json(document);
  } catch (error) {
    console.error("TEXT INGESTION ERROR:", error);

    return res.status(500).json({
      error: "Failed to ingest text",
    });
  }
}
