import { retrieveChunks } from "../vector/vector.service";
import { generateAnswer } from "../LLM/llm.service";

export async function answerQuestion(
  question: string,
  notebookId: number,
  topK = 3,
) {
  const totalStart = Date.now();

  const chunks = await retrieveChunks(
    question,
    notebookId,
    topK,
  );

  if (chunks.length === 0) {
    return {
      answer: "I could not find relevant information in this document.",
      sources: [],
    };
  }

  const context = chunks
    .map(
      (chunk, index) =>
        `[${index + 1}]\n${chunk.content}`,
    )
    .join("\n\n");

  const sources = chunks.map((chunk, index) => ({
    index: index + 1,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    chunkId: chunk.chunkId,
    chunkIndex: chunk.chunkIndex,
    score: chunk.score,
  }));

  const answer = await generateAnswer(
    question,
    context,
    sources.map((source) => source.index),
  );

  console.log(
    `RAG ask completed in ${Date.now() - totalStart}ms`,
  );

  return {
    answer,
    sources,
  };
}
