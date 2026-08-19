import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Paperclip, X as XIcon, Loader2 } from "lucide-react";

export function ChatInputForm({
  onSubmit, attachment, onRemoveAttachment, fileRef, onPickFile,
  uploading, sending, text, setText,
}: {
  onSubmit: (e: React.FormEvent) => void;
  attachment: { url: string; mime: string; localName: string } | null;
  onRemoveAttachment: () => void;
  fileRef: RefObject<HTMLInputElement>;
  onPickFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  uploading: boolean;
  sending: boolean;
  text: string;
  setText: (v: string) => void;
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="sticky bottom-0 z-10 border-t border-border/50 bg-background/95 backdrop-blur px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
    >
      {attachment && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 p-2">
          <div className="w-10 h-10 rounded overflow-hidden bg-muted flex items-center justify-center shrink-0">
            <img src={attachment.url} alt="" className="w-full h-full object-cover" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs truncate">{attachment.localName}</div>
            <div className="text-[10px] text-muted-foreground">Готово к отправке</div>
          </div>
          <button
            type="button"
            onClick={onRemoveAttachment}
            className="p-1 rounded hover:bg-muted"
            aria-label="Удалить"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onPickFile}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="shrink-0 h-9 w-9"
          onClick={() => fileRef.current?.click()}
          disabled={uploading || sending}
          aria-label="Прикрепить фото"
        >
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
        </Button>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Сообщение…"
          rows={1}
          className="flex-1 min-h-[36px] max-h-32 resize-none py-2"
          data-testid="input-support-text"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit(e as any);
            }
          }}
        />
        <Button
          type="submit"
          size="icon"
          className="shrink-0 h-9 w-9"
          disabled={sending || uploading || (!text.trim() && !attachment)}
          data-testid="button-support-send"
          aria-label="Отправить"
        >
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </Button>
      </div>
    </form>
  );
}
