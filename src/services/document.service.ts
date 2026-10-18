import { db } from "../prisma/db";
import { normalizeText } from "./ingestion/text.service";
type CreateDocumentInput = {
  title: string;
  sourceType: string;
  sourceUrl?: string | undefined;
  storageKey?: string | undefined;
  content?: string | undefined;
  status: string;
  notebookId: number;
};

export async function createDocument(input: CreateDocumentInput) {
  const content = input.content
    ? normalizeText(input.content)
    : null;

  const document = await db.orm.public.Document.create({
    title: input.title,
    sourceType: input.sourceType,
    sourceUrl: input.sourceUrl ?? null,
    storageKey: input.storageKey ?? null,
    content,
    status: input.status,
    notebookId: input.notebookId,
  });

  return document;
}
export async function getDocumentById(id: number) {
  const document = await db.orm.public.Document
    .where({
      id,
    })
    .include("notebook", (notebook) =>
      notebook.include("workspace", (workspace) =>
        workspace.include("owner"),
      ),
    )
    .include("chunks")
    .first();

  return document;
}

export async function deleteDocument(id: number) {
  const document = await db.orm.public.Document
    .where({
      id,
    })
    .first();

  if (!document) {
    return null;
  }

  await db.orm.public.Chunk
    .where({
      documentId: id,
    })
    .delete();

  await db.orm.public.Document
    .where({
      id,
    })
    .delete();

  return document;
}

export async function updateDocumentStatus(
  id: number,
  status: string,
) {
  return db.orm.public.Document
    .where({ id })
    .update({
      status,
    });
}

/**
 * Every document in a given status.
 *
 * Used to find sources left mid-ingestion by a restart. Kept as an equality
 * filter rather than an `in`, matching the rest of the service.
 */
export async function findDocumentsByStatus(status: string) {
  return db.orm.public.Document
    .where({ status })
    .all();
}