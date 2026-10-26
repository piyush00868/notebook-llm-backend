import { Mistral } from "@mistralai/mistralai";

const mistral = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY,
});

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

async function retryWithBackoff<T>(fn: () => Promise<T>, attempt = 0): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    if (error.status === 429 && attempt < MAX_RETRIES) {
      const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.log(`Mistral rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return retryWithBackoff(fn, attempt + 1);
    }
    throw error;
  }
}

export async function generateEmbeddings(texts: string[]) {
  if (texts.length === 0) {
    return [];
  }

  const response = await retryWithBackoff(() =>
    mistral.embeddings.create({
      model: "mistral-embed",
      inputs: texts,
    })
  );

  return response.data.map((item) => item.embedding);
}

export async function testEmbedding(text: string) {
  const embedding = await generateEmbeddings([text]);

  console.log("EMBEDDING LENGTH:", embedding.length);
  console.log("FIRST 5 VALUES:", embedding.slice(0, 5));

  return embedding;
}
