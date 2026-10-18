import { Pinecone } from "@pinecone-database/pinecone";
import { db } from "../../prisma/db";
import { generateEmbeddings } from "../embedding/embedding.service";

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY!,
});

const indexName = process.env.PINECONE_INDEX_NAME!;

export function getVectorIndex() {
  return pinecone.index({
    name: indexName,
  });
}

export async function indexDocumentChunks(documentId: number) {
  
  const document = await db.orm.public.Document
    .where({
      id: documentId,
    })
    .first();

  if (!document) {
    throw new Error("Document not found");
  }

  const chunks = await db.orm.public.Chunk
    .where({
      documentId,
    })
    .all();

  if (chunks.length === 0) {
    return 0;
  }

  const embeddings = await generateEmbeddings(
    chunks.map((chunk) => chunk.content),
  );

  const index = getVectorIndex();

  await index.upsert({
    records: chunks.map((chunk, index) => ({
      id: `chunk-${chunk.id}`,
      values: embeddings[index]!,
      metadata: {
        documentId: chunk.documentId,
        notebookId: document.notebookId,
        chunkId: chunk.id,
        chunkIndex: chunk.chunkIndex,
      },
    })),
  });

  return chunks.length;
}

export async function searchSimilarChunks(
  query: string,
  notebookId: number,
  topK = 3,
) {
  const queryEmbedding = await generateEmbeddings([query]);

  const index = getVectorIndex();

  const result = await index.query({
    vector: queryEmbedding[0]!,
    topK,
    includeMetadata: true,
    filter: {
      notebookId: {
        $eq: notebookId,
      },
    },
  });

  return result.matches ?? [];
}
export async function retrieveChunks(
  query: string,
  notebookId: number,
  topK = 3,
) {
  const matches = await searchSimilarChunks(
    query,
    notebookId,
    topK,
  );

  if (matches.length === 0) {
    return [];
  }
  const chunkIds = matches
    .map((match) => match.metadata?.chunkId)
    .filter((id): id is number => typeof id === "number");
 if (chunkIds.length === 0) {
    return [];
  }

 const chunks = [];

for (const chunkId of chunkIds) {
const chunk = await db.orm.public.Chunk
  .where({
    id: chunkId,
  })
  .include("document")
  .first();

  if (chunk) {
    chunks.push(chunk);
  }
}

  const chunkMap = new Map(
    chunks.map((chunk) => [chunk.id, chunk]),
  );

  return matches
    .map((match) => {
      const chunkId = match.metadata?.chunkId;

      if (typeof chunkId !== "number") {
        return null;
      }

      const chunk = chunkMap.get(chunkId);

      if (!chunk) {
        return null;
      }

      return {
        chunkId: chunk.id,
        chunkIndex: chunk.chunkIndex,
        score: match.score,
        content: chunk.content,
        documentId: chunk.documentId,
        documentTitle: chunk.document.title,
      };
    })
    .filter(
      (
        chunk,
      ): chunk is {
        chunkId: number;
        chunkIndex: number;
        score: number | undefined;
        content: string;
        documentId: number;
        documentTitle: string;
      } => chunk !== null,
    );
}

/**
 * Pinecone caps how many ids one delete accepts, and a long source produces
 * a lot of chunks, so deletions go out in batches.
 */
const DELETE_BATCH_SIZE = 500;

/**
 * Removes a document's vectors.
 *
 * Chunk ids are read first because the caller deletes the rows holding them
 * straight afterwards, and Pinecone can only find a vector by its id.
 *
 * Returns how many vectors were removed.
 */
export async function deleteDocumentVectors(
  documentId: number,
): Promise<number> {
  const chunks = await db.orm.public.Chunk
    .where({ documentId })
    .all();

  if (chunks.length === 0) {
    return 0;
  }

  const ids = chunks.map((chunk) => `chunk-${chunk.id}`);
  const index = getVectorIndex();

  for (let offset = 0; offset < ids.length; offset += DELETE_BATCH_SIZE) {
    await index.deleteMany({
      ids: ids.slice(offset, offset + DELETE_BATCH_SIZE),
    });
  }

  return ids.length;
}

/**
 * Deletes vectors whose chunk is no longer in the database.
 *
 * Deleting a source now takes its vectors with it, but vectors outlive any
 * failure in between: a document removed before this was in place, or a
 * Pinecone delete that did not land. They are not harmless -- retrieval asks
 * for a fixed number of matches and discards those it cannot resolve, so an
 * orphan quietly uses up a slot a real chunk needed.
 *
 * Safe to run at any time: it only ever removes vectors whose chunk is gone.
 */
export async function pruneOrphanVectors(): Promise<{
  scanned: number;
  deleted: number;
}> {
  const chunks = await db.orm.public.Chunk.all();
  const liveChunkIds = new Set(chunks.map((chunk) => chunk.id));

  const index = getVectorIndex();
  const orphans: string[] = [];
  let scanned = 0;
  let token: string | undefined;

  do {
    const page = await index.listPaginated(token ? { paginationToken: token } : {});

    for (const vector of page.vectors ?? []) {
      scanned += 1;
      const id = vector.id;

      if (!id) {
        continue;
      }

      /*
       * Pinecone's list endpoint returns ids alone, so the chunk is recovered
       * from the id this codebase wrote. Anything not in that shape is treated
       * as an orphan rather than left in place on the assumption it is fine.
       */
      const match = /^chunk-(\d+)$/.exec(id);

      if (!match || !liveChunkIds.has(Number(match[1]))) {
        orphans.push(id);
      }
    }

    token = page.pagination?.next || undefined;
  } while (token);

  for (let offset = 0; offset < orphans.length; offset += DELETE_BATCH_SIZE) {
    await index.deleteMany({
      ids: orphans.slice(offset, offset + DELETE_BATCH_SIZE),
    });
  }

  console.log(`Pruned ${orphans.length} orphan vector(s) of ${scanned} scanned`);

  return { scanned, deleted: orphans.length };
}