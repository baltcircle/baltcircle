import { ChevronRight } from "lucide-react";
import type { User as UserType } from "@shared/schema";

export function ProfileSection({
  isRegistered, editingName, setEditingName, name, setName, onSaveName,
  user, onOpenPhoneModal, onOpenEmailModal,
}: {
  isRegistered: boolean;
  editingName: boolean;
  setEditingName: (fn: (v: boolean) => boolean) => void;
  name: string;
  setName: (v: string) => void;
  onSaveName: () => void;
  user: UserType | null | undefined;
  onOpenPhoneModal: () => void;
  onOpenEmailModal: () => void;
}) {
  // Почту указывают при регистрации без подтверждения, поэтому адрес может
  // быть заполнен, а emailVerifiedAt — пустым. Подпись только сообщает об
  // этом; окно выбирает сама строка почты — подтверждение для
  // неподтверждённой, смена для подтверждённой.
  const needsEmailVerification = !!user?.email && !user?.emailVerifiedAt;
  return (
    <div className="rounded-2xl border border-gray-200 dark:border-zinc-800 overflow-hidden bg-white dark:bg-zinc-800 shrink-0">
      {/* Name */}
      <div
        className="px-4 py-3 border-b border-gray-100 dark:border-zinc-700 cursor-pointer"
        onClick={() => isRegistered && setEditingName(v => !v)}
      >
        {editingName ? (
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            onBlur={onSaveName}
            onKeyDown={e => e.key === "Enter" && onSaveName()}
            className="w-full text-base font-semibold text-gray-900 dark:text-white bg-transparent border-b border-blue-500 outline-none"
          />
        ) : (
          <p className="text-base font-semibold text-gray-900 dark:text-white">{name || "—"}</p>
        )}
        <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">Твоё имя</p>
      </div>

      {/* Phone */}
      <button
        type="button"
        onClick={onOpenPhoneModal}
        className="w-full px-4 py-3 border-b border-gray-100 dark:border-zinc-700 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-zinc-700/50 transition-colors"
      >
        <div className="text-left">
          <p className="text-base font-semibold text-gray-900 dark:text-white">{user?.phone ?? "—"}</p>
          <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">Номер телефона</p>
        </div>
        <ChevronRight className="w-4 h-4 text-gray-400 dark:text-zinc-500 shrink-0" />
      </button>

      {/* Email */}
      <div>
        <button
          type="button"
          onClick={onOpenEmailModal}
          className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-zinc-700/50 transition-colors"
        >
          <span className="text-left">
            <span className="block text-base font-semibold text-gray-900 dark:text-white">{user?.email ?? "—"}</span>
            {/* Подпись — просто текст в строке подписи, без своей строки:
                окно открывает сама строка почты. */}
            <span className="block text-xs mt-0.5 text-gray-400 dark:text-zinc-500">
              Email
              {needsEmailVerification && (
                <span className="ml-2 font-medium text-red-500" data-testid="text-verify-email">
                  Подтвердите почту
                </span>
              )}
            </span>
          </span>
          <ChevronRight className="w-4 h-4 text-gray-400 dark:text-zinc-500 shrink-0" />
        </button>
      </div>
    </div>
  );
}
