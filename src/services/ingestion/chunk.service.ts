import { db } from "../../prisma/db";
export function chunkText(
  text: string,
  chunkSize = 1000,
  overlap = 200,
): string[] {
  if (chunkSize <= 0) {
    throw new Error("chunkSize must be greater than 0");
  }

  if (overlap < 0 || overlap >= chunkSize) {
    throw new Error("overlap must be >= 0 and less than chunkSize");
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const remaining = text.slice(start);

    if (remaining.length <= chunkSize) {
      const finalChunk = remaining.trim();

      if (finalChunk) {
        chunks.push(finalChunk);
      }

      break;
    }

    const candidate = remaining.slice(0, chunkSize);

    // Prefer paragraph boundary.
    let end = candidate.lastIndexOf("\n\n");

    // Otherwise prefer sentence boundary.
    if (end <= 0) {
      const sentenceMatches = [...candidate.matchAll(/[.!?](?=\s)/g)];
      if (sentenceMatches.length > 0) {
        const lastMatch = sentenceMatches[sentenceMatches.length - 1];
        if (lastMatch) {
          end = lastMatch.index! + 1;
        }
      }
    }

    // Otherwise prefer word boundary.
    if (end <= 0) {
      end = candidate.lastIndexOf(" ");
    }

    // Absolute fallback.
    if (end <= 0) {
      end = chunkSize;
    }

    const chunk = text.slice(start, start + end).trim();

    if (chunk) {
      chunks.push(chunk);
    }

    const nextStart = start + end - overlap;

    // Prevent getting stuck.
    if (nextStart <= start) {
      start = start + end;
    } else {
      start = nextStart;
    }
  }

  return chunks;
}

export async function createDocumentChunks(documentId: number) {
  const existingChunks = await db.orm.public.Chunk
  .where({
    documentId,
  })
  .all();

if (existingChunks.length > 0) {
  return existingChunks.map((chunk) => chunk.content);
}
  
  const document = await db.orm.public.Document.where({
    id: documentId,
  }).first();

  if (!document) {
    throw new Error("Document not found");
  }

  if (!document.content) {
    throw new Error("Document has no content");
  }

  const chunks = chunkText(document.content);

  for (let index = 0; index < chunks.length; index++) {
    try {
      await db.orm.public.Chunk.create({
        content: chunks[index]!,
        chunkIndex: index,
        documentId,
      });
    } catch (error) {
      // Unique constraint on (documentId, chunkIndex) means another instance
      // already created this chunk during a concurrent deploy. Skip it.
      if ((error as { code?: string }).code === "P2002") {
        continue;
      }
      throw error;
    }
  }

  return chunks;
}
