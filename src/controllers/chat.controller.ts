import type { Request, Response } from "express";
import { getAuth } from "@clerk/express";
import { answerQuestion } from "../services/RAG/rag.service";
import { saveChatMessage } from "../services/chat.service";
import {
  createChat,
  getChatsByNotebookId,
  getChatMessages,
  deleteChat,
} from "../services/chat.service";
import { getNotebookById } from "../services/notebook.service";
import { assertOwner } from "../services/authorization.service";
import { db } from "../prisma/db";

export async function createChatController(
  req: Request,
  res: Response,
) {
  const { userId } = getAuth(req);

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const notebookId = Number(req.params.id);

    if (!Number.isInteger(notebookId) || notebookId <= 0) {
      return res.status(400).json({ error: "Invalid notebook id" });
    }

    const notebook = await getNotebookById(notebookId);

    if (!notebook) {
      return res.status(404).json({ error: "Notebook not found" });
    }

    if (!notebook.workspace) {
      return res.status(500).json({ error: "Notebook workspace not found" });
    }

    try {
      assertOwner(notebook.workspace.owner.clerkUserId, userId);
    } catch {
      return res.status(403).json({ error: "Forbidden" });
    }

    const chat = await createChat(notebookId);

    return res.status(201).json(chat);
  } catch (error) {
    console.error("CREATE CHAT ERROR:", error);
    return res.status(500).json({ error: "Failed to create chat" });
  }
}

export async function listChatsController(
  req: Request,
  res: Response,
) {
  const { userId } = getAuth(req);

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const notebookId = Number(req.params.id);

    if (!Number.isInteger(notebookId) || notebookId <= 0) {
      return res.status(400).json({ error: "Invalid notebook id" });
    }

    const notebook = await getNotebookById(notebookId);

    if (!notebook) {
      return res.status(404).json({ error: "Notebook not found" });
    }

    if (!notebook.workspace) {
      return res.status(500).json({ error: "Notebook workspace not found" });
    }

    try {
      assertOwner(notebook.workspace.owner.clerkUserId, userId);
    } catch {
      return res.status(403).json({ error: "Forbidden" });
    }

    const chats = await getChatsByNotebookId(notebookId);

    return res.status(200).json(chats);
  } catch (error) {
    console.error("LIST CHATS ERROR:", error);
    return res.status(500).json({ error: "Failed to list chats" });
  }
}


/**
 * Deletes one conversation, with its messages.
 *
 * Ownership is checked through the chat's notebook → workspace owner, the same
 * chain the read and ask routes use, so a chat id from another account is
 * rejected rather than deleted.
 */
export async function deleteChatController(
  req: Request,
  res: Response,
) {
  const { userId } = getAuth(req);

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const chatId = Number(req.params.chatId);

    if (!Number.isInteger(chatId) || chatId <= 0) {
      return res.status(400).json({ error: "Invalid chat id" });
    }

    const chat = await db.orm.public.Chat
      .where({ id: chatId })
      .first();

    if (!chat) {
      return res.status(404).json({ error: "Chat not found" });
    }

    const notebook = await getNotebookById(chat.notebookId);

    if (!notebook) {
      return res.status(404).json({ error: "Notebook not found" });
    }

    if (!notebook.workspace) {
      return res.status(500).json({
        error: "Notebook workspace not found",
      });
    }

    try {
      assertOwner(notebook.workspace.owner.clerkUserId, userId);
    } catch {
      return res.status(403).json({ error: "Forbidden" });
    }

    const deleted = await deleteChat(chatId);

    if (!deleted) {
      return res.status(404).json({ error: "Chat not found" });
    }

    return res.status(200).json({ message: "Chat deleted", chat: deleted });
  } catch (error) {
    console.error("DELETE CHAT ERROR:", error);

    return res.status(500).json({
      error: "Failed to delete chat",
    });
  }
}

export async function getChatMessagesController(
  req: Request,
  res: Response,
) {
  const { userId } = getAuth(req);

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const chatId = Number(req.params.chatId);

    if (!Number.isInteger(chatId) || chatId <= 0) {
      return res.status(400).json({ error: "Invalid chat id" });
    }

    const chat = await db.orm.public.Chat
      .where({ id: chatId })
      .first();

    if (!chat) {
      return res.status(404).json({ error: "Chat not found" });
    }

    const notebook = await getNotebookById(chat.notebookId);

    if (!notebook) {
      return res.status(404).json({ error: "Notebook not found" });
    }

    if (!notebook.workspace) {
      return res.status(500).json({
        error: "Notebook workspace not found",
      });
    }

    try {
      assertOwner(notebook.workspace.owner.clerkUserId, userId);
    } catch {
      return res.status(403).json({ error: "Forbidden" });
    }

    const messages = await getChatMessages(chatId);

    return res.status(200).json(messages);
  } catch (error) {
    console.error("GET CHAT MESSAGES ERROR:", error);

    return res.status(500).json({
      error: "Failed to get chat messages",
    });
  }
}


export async function askChatController(
  req: Request,
  res: Response,
) {
  const { userId } = getAuth(req);

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const chatId = Number(req.params.chatId);

    if (!Number.isInteger(chatId) || chatId <= 0) {
      return res.status(400).json({ error: "Invalid chat id" });
    }

    const question = String(req.body.question ?? "").trim();

    if (!question) {
      return res.status(400).json({ error: "Question is required" });
    }

    if (question.length > 2000) {
      return res.status(400).json({
        error: "Question is too long. Maximum 2,000 characters allowed.",
      });
    }

    const chat = await db.orm.public.Chat
      .where({ id: chatId })
      .first();

    if (!chat) {
      return res.status(404).json({ error: "Chat not found" });
    }

    const notebook = await getNotebookById(chat.notebookId);

    if (!notebook) {
      return res.status(404).json({ error: "Notebook not found" });
    }

    if (!notebook.workspace) {
      return res.status(500).json({
        error: "Notebook workspace not found",
      });
    }

    try {
      assertOwner(notebook.workspace.owner.clerkUserId, userId);
    } catch {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Save the user's question in this chat.
    await saveChatMessage(chatId, "user", question);

    // Use the notebook's sources to generate the answer.
    const result = await answerQuestion(question, chat.notebookId, 5);

    // Save the assistant's answer in the same chat.
await saveChatMessage(
  chatId,
  "assistant",
  result.answer,
  result.sources.map((source) => {
  const { score, ...rest } = source;
  return score === undefined
    ? rest
    : { ...rest, score };
})
)
    return res.status(200).json(result);
  } catch (error) {
    console.error("CHAT ASK ERROR:", error);

    return res.status(500).json({
      error: "Failed to answer chat question",
    });
  }
}
