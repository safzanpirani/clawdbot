import { describe, expect, it, vi } from "vitest";

vi.mock("../web/media.js", async () => {
  const actual = await vi.importActual<typeof import("../web/media.js")>(
    "../web/media.js",
  );
  return {
    ...actual,
    loadWebMedia: vi.fn(),
  };
});

import { loadWebMedia } from "../web/media.js";
import { sendMessageTelegram } from "./send.js";

describe("sendMessageTelegram", () => {
  it("falls back to plain text when Telegram rejects Markdown", async () => {
    const chatId = "123";
    const parseErr = new Error(
      "400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 9",
    );
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(parseErr)
      .mockResolvedValueOnce({
        message_id: 42,
        chat: { id: chatId },
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    const res = await sendMessageTelegram(chatId, "_oops_", {
      token: "tok",
      api,
      verbose: true,
    });

    expect(sendMessage).toHaveBeenNthCalledWith(1, chatId, "_oops_", {
      parse_mode: "Markdown",
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, chatId, "_oops_");
    expect(res.chatId).toBe(chatId);
    expect(res.messageId).toBe("42");
  });

  it("normalizes chat ids with internal prefixes", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 1,
      chat: { id: "123" },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram("telegram:123", "hi", {
      token: "tok",
      api,
    });

    expect(sendMessage).toHaveBeenCalledWith("123", "hi", {
      parse_mode: "Markdown",
    });
  });

  it("wraps chat-not-found with actionable context", async () => {
    const chatId = "123";
    const err = new Error("400: Bad Request: chat not found");
    const sendMessage = vi.fn().mockRejectedValue(err);
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(
      sendMessageTelegram(chatId, "hi", { token: "tok", api }),
    ).rejects.toThrow(/chat not found/i);
    await expect(
      sendMessageTelegram(chatId, "hi", { token: "tok", api }),
    ).rejects.toThrow(/chat_id=123/);
  });

  it("sends ogg audio as a voice message", async () => {
    const chatId = "123";
    const sendVoice = vi.fn().mockResolvedValue({
      message_id: 2,
      chat: { id: chatId },
    });
    const sendAudio = vi.fn();
    const sendDocument = vi.fn();
    const api = {
      sendVoice,
      sendAudio,
      sendDocument,
    } as unknown as {
      sendVoice: typeof sendVoice;
      sendAudio: typeof sendAudio;
      sendDocument: typeof sendDocument;
    };
    vi.mocked(loadWebMedia).mockResolvedValueOnce({
      buffer: Buffer.from("audio"),
      contentType: "audio/ogg",
      kind: "audio",
      fileName: "tts.ogg",
    });

    const res = await sendMessageTelegram(chatId, "hi", {
      token: "tok",
      api,
      mediaUrl: "https://example.com/tts.ogg",
    });

    expect(sendVoice).toHaveBeenCalledOnce();
    expect(sendAudio).not.toHaveBeenCalled();
    expect(sendDocument).not.toHaveBeenCalled();
    expect(res.messageId).toBe("2");
  });
});
