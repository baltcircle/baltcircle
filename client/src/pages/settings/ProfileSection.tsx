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
      <button
        type="button"
        onClick={onOpenEmailModal}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-zinc-700/50 transition-colors"
      >
        <div className="text-left">
          <p className="text-base font-semibold text-gray-900 dark:text-white">{user?.email ?? "—"}</p>
          <p className="text-xs mt-0.5">
            <span className="text-gray-400 dark:text-zinc-500">Email</span>
            {user?.emailVerifiedAt && <span className="text-green-500 ml-1">· Подтверждён</span>}
          </p>
        </div>
        <ChevronRight className="w-4 h-4 text-gray-400 dark:text-zinc-500 shrink-0" />
      </button>
    </div>
  );
}
