import { Router } from "express";
import {
  createNotebookController,
  getNotebookController,
  deleteNotebookController,
  askNotebookController,
} from "../controllers/notebook.controller";
import { getChatMessagesController, askChatController, deleteChatController } from "../controllers/chat.controller";
import { requireAuth } from "../middleware/auth.middleware";
import { askLimiter, askHourlyLimiter } from "../middleware/rateLimit.middleware";
import {
  createChatController,
  listChatsController,
} from "../controllers/chat.controller";

const router = Router();

router.use(requireAuth);
router.post("/", createNotebookController);
router.get("/:id", getNotebookController);
router.post("/:id/ask", askLimiter, askHourlyLimiter, askChatController);
router.delete("/:id", deleteNotebookController);
router.post("/:id/chats", createChatController);
router.get("/:id/chats", listChatsController);
router.get("/chats/:chatId/messages", getChatMessagesController);
router.delete("/chats/:chatId", deleteChatController);
router.post("/chats/:chatId/ask", askLimiter, askHourlyLimiter, askChatController);
export default router;
