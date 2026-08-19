import type { SupportMessage } from "@shared/schema";
import { fmtTime } from "./utils";

export function MessageBubble({ message }: { message: SupportMessage }) {
  const isUser = message.senderRole === "user";
  const isSystem = message.senderRole === "system";
  const isBot = message.senderRole === "bot";

  if (isSystem) {
    return (
      <div className="text-center text-[10px] text-muted-foreground py-1">
        {message.body}
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`} data-testid={`support-msg-${message.id}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-3 py-2 ${
          isUser
            ? "bg-primary text-primary-foreground rounded-br-md"
            : "bg-muted rounded-bl-md"
        }`}
      >
        {!isUser && (
          <div className="text-[10px] font-medium opacity-70 mb-0.5">{isBot ? "Бот поддержки" : "Оператор"}</div>
        )}
        {message.attachmentUrl && (
          <a
            href={message.attachmentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block mb-1"
          >
            <img
              src={message.attachmentUrl}
              alt="Вложение"
              className="max-w-full max-h-64 rounded-lg object-cover"
            />
          </a>
        )}
        {message.body && (
          <div className="text-sm whitespace-pre-wrap break-words leading-snug">{message.body}</div>
        )}
        <div className={`text-[10px] mt-0.5 ${isUser ? "opacity-70" : "text-muted-foreground"} text-right`}>
          {fmtTime(message.createdAt)}
        </div>
      </div>
    </div>
  );
}
