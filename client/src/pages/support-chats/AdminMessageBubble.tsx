import type { SupportMessage } from "@shared/schema";
import { fmtTime } from "./utils";

export function AdminMessageBubble({ message }: { message: SupportMessage }) {
  const isOperator = message.senderRole === "operator";
  const isSystem = message.senderRole === "system";

  if (isSystem) {
    return (
      <div className="text-center text-[10px] text-muted-foreground py-1">{message.body}</div>
    );
  }

  return (
    <div className={`flex ${isOperator ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-3 py-2 ${
          isOperator
            ? "bg-primary text-primary-foreground rounded-br-md"
            : "bg-muted rounded-bl-md"
        }`}
      >
        {!isOperator && (
          <div className="text-[10px] font-medium opacity-70 mb-0.5">Пользователь</div>
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
              className="max-w-full max-h-72 rounded-lg object-cover"
            />
          </a>
        )}
        {message.body && (
          <div className="text-sm whitespace-pre-wrap break-words leading-snug">{message.body}</div>
        )}
        <div className={`text-[10px] mt-0.5 ${isOperator ? "opacity-70" : "text-muted-foreground"} text-right`}>
          {fmtTime(message.createdAt)}
        </div>
      </div>
    </div>
  );
}
