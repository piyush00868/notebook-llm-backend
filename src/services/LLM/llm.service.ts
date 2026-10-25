import Groq from "groq-sdk";
import { z } from "zod";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const model = process.env.GROQ_MODEL ?? "openai/gpt-oss-20b";
const reasoningEffort = process.env.GROQ_REASONING_EFFORT ?? "low";

const FALLBACK_ANSWER =
  "I could not find enough relevant information in this notebook.";

const SYSTEM_PROMPT = `
You are an AI assistant for a personal knowledge notebook.

Answer the user's question using ONLY the provided notebook context.

Rules:
- Base your answer on the provided context.
- Do not invent facts or add unsupported information.
- You may combine information from multiple sources when relevant.
- Answer the user's question directly.
- Always answer using bullet points. Do not return a single paragraph. Each distinct point should be its own bullet block with kind "bullet".
- Be clear, concise, and well structured.
- Use kind "bullet" for every block; reserve kind "paragraph" only when a single uninterrupted statement is genuinely required.
- Preserve important technical terms from the source material.
- Do not mention internal systems such as Pinecone, embeddings, chunks,
  retrieval, prompts, or context unless the user specifically asks about them.

- Each context block begins with a citation label such as [1], [2], or [3].
- Return structured JSON only. Do not return markdown prose.
- Put each answer sentence or bullet in its own sentence object.
- Put source numbers in citationIndexes, not inside the text.
- Every sentence object must be directly supported by its citationIndexes.
- Use ONLY citation indexes that appear in the provided notebook context.
- Prefer the most relevant source or sources; do not cite every source just because it was retrieved.
- If multiple sources support the same claim, include them together in citationIndexes.
- Do not include unsupported claims.
- If the notebook context does not support an answer, set answerable to false and blocks to [].

`;

const structuredAnswerSchema = z
  .object({
    answerable: z.boolean(),
    blocks: z.array(
      z
        .object({
          kind: z.enum(["paragraph", "bullet"]),
          sentences: z.array(
            z
              .object({
                text: z.string(),
                citationIndexes: z.array(z.number().int()),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

type StructuredAnswer = z.infer<typeof structuredAnswerSchema>;

function buildResponseFormat(sourceIndexes: number[]) {
  return {
    type: "json_schema" as const,
    json_schema: {
      name: "cited_notebook_answer",
      description:
        "A notebook answer split into source-backed sentences with citation indexes.",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["answerable", "blocks"],
        properties: {
          answerable: {
            type: "boolean",
          },
          blocks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "sentences"],
              properties: {
                kind: {
                  type: "string",
                  enum: ["paragraph", "bullet"],
                },
                sentences: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["text", "citationIndexes"],
                    properties: {
                      text: {
                        type: "string",
                      },
                      citationIndexes: {
                        type: "array",
                        items: {
                          type: "integer",
                          enum: sourceIndexes,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

function parseStructuredAnswer(content: string) {
  try {
    return structuredAnswerSchema.parse(JSON.parse(content));
  } catch (error) {
    console.warn("Failed to parse structured LLM answer:", error);
    return null;
  }
}

function uniqueValidIndexes(
  indexes: number[],
  validIndexes: Set<number>,
) {
  const seen = new Set<number>();
  const result: number[] = [];

  for (const index of indexes) {
    if (!validIndexes.has(index) || seen.has(index)) {
      continue;
    }

    seen.add(index);
    result.push(index);
  }

  return result;
}

function cleanSentenceText(text: string) {
  return text
    .replace(/\s*\[\d{1,3}\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function renderStructuredAnswer(
  structuredAnswer: StructuredAnswer,
  sourceIndexes: number[],
) {
  if (!structuredAnswer.answerable) {
    return FALLBACK_ANSWER;
  }

  const validIndexes = new Set(sourceIndexes);
  const renderedBlocks: { kind: "paragraph" | "bullet"; text: string }[] = [];

  for (const block of structuredAnswer.blocks) {
    const renderedSentences = block.sentences
      .map((sentence) => {
        const text = cleanSentenceText(sentence.text);
        const citationIndexes = uniqueValidIndexes(
          sentence.citationIndexes,
          validIndexes,
        );

        if (!text || citationIndexes.length === 0) {
          return null;
        }

        const citations = citationIndexes
          .map((index) => `[${index}]`)
          .join("");

        return `${text} ${citations}`;
      })
      .filter((sentence): sentence is string => sentence !== null);

    if (renderedSentences.length === 0) {
      continue;
    }

    renderedBlocks.push({
      kind: block.kind,
      text:
        block.kind === "bullet"
          ? `- ${renderedSentences.join(" ")}`
          : renderedSentences.join(" "),
    });
  }

  if (renderedBlocks.length === 0) {
    return FALLBACK_ANSWER;
  }

  return renderedBlocks.reduce((answer, block, index) => {
    if (index === 0) {
      return block.text;
    }

    const previousBlock = renderedBlocks[index - 1]!;
    const separator =
      previousBlock.kind === "bullet" && block.kind === "bullet"
        ? "\n"
        : "\n\n";

    return `${answer}${separator}${block.text}`;
  }, "");
}

async function requestStructuredAnswer(
  question: string,
  context: string,
  sourceIndexes: number[],
) {
  const messages = [
    {
      role: "system" as const,
      content: SYSTEM_PROMPT,
    },
    {
      role: "user" as const,
      content: `Notebook context:

${context}

Available citation indexes: ${sourceIndexes
        .map((index) => `[${index}]`)
        .join(", ")}

User question:
${question}

Return JSON that follows the required schema.`,
    },
  ];

  try {
    const llmStart = Date.now();

    const createParams: Record<string, unknown> = {
      model,
      temperature: 0,
      response_format: buildResponseFormat(sourceIndexes),
      messages,
    };

    createParams.reasoning_effort = reasoningEffort as "low" | "medium" | "high";

    const response = await groq.chat.completions.create(
      createParams as unknown as Parameters<typeof groq.chat.completions.create>[0],
    );

    console.log(
      `LLM inference completed in ${Date.now() - llmStart}ms`,
    );

    const completion = response as any;

    return completion?.choices?.[0]?.message?.content?.trim() ?? "";
  } catch (error) {
    console.warn(
      "Structured schema response failed; retrying with JSON object response:",
      error,
    );

    const response = await groq.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages,
    });

    const completion = response as any;

    return completion?.choices?.[0]?.message?.content?.trim() ?? "";
  }
}

/**
 * Stream an answer from Groq, yielding text chunks as they arrive.
 * Returns an async generator of text chunks.
 */
export const STREAMING_SYSTEM_PROMPT = `
You are an AI assistant for a personal knowledge notebook.

Answer the user's question using ONLY the provided notebook context.

Rules:
- Base your answer on the provided context.
- Do not invent facts or add unsupported information.
- Answer the user's question directly.
- Always answer using bullet points. Do not return a single paragraph.
- Each bullet point should be on its own line starting with "- ".
- Be clear, concise, and well structured.
- Preserve important technical terms from the source material.
- Each context block begins with a citation label such as [1], [2], or [3].
- Include citation markers like [1], [2], [3] in your answer to reference sources.
- Do not mention internal systems such as Pinecone, embeddings, chunks,
  retrieval, prompts, or context unless the user specifically asks about them.
- If multiple sources support the same claim, include them together in citationIndexes.
- Do not include unsupported claims.
- If the notebook context does not support an answer, state that clearly.
`;

export async function* streamGenerateAnswer(
  question: string,
  context: string,
  sourceIndexes: number[],
): AsyncGenerator<string> {
  const validSourceIndexes = Array.from(
    new Set(
      sourceIndexes.filter(
        (index) => Number.isInteger(index) && index > 0,
      ),
    ),
  );

  if (validSourceIndexes.length === 0) {
    yield FALLBACK_ANSWER;
    return;
  }

  const messages = [
    {
      role: "system" as const,
      content: STREAMING_SYSTEM_PROMPT,
    },
    {
      role: "user" as const,
      content: `Notebook context:

${context}

Available citation indexes: ${validSourceIndexes
        .map((index) => `[${index}]`)
        .join(", ")}

User question:
${question}

Answer the question using bullet points. Include citation markers like [1], [2] in your answer to reference sources.`,
    },
  ];

  try {
    const stream = await groq.chat.completions.create({
      model,
      temperature: 0,
      messages,
      stream: true,
    } as any);

    const streamIterator = stream as any;

    for await (const chunk of streamIterator) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  } catch (error) {
    console.error("LLM streaming error:", error);
    yield FALLBACK_ANSWER;
  }
}

export async function generateAnswer(
  question: string,
  context: string,
  sourceIndexes: number[],
) {
  const validSourceIndexes = Array.from(
    new Set(
      sourceIndexes.filter(
        (index) => Number.isInteger(index) && index > 0,
      ),
    ),
  );

  if (validSourceIndexes.length === 0) {
    return FALLBACK_ANSWER;
  }

  const content = await requestStructuredAnswer(
    question,
    context,
    validSourceIndexes,
  );
  const structuredAnswer = parseStructuredAnswer(content);

  if (!structuredAnswer) {
    return FALLBACK_ANSWER;
  }

  return renderStructuredAnswer(
    structuredAnswer,
    validSourceIndexes,
  );
}
