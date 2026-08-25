import type { User, UserRole } from "@shared/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Tooltip, TooltipContent, TooltipTrigger,
} from "@/components/ui/tooltip";
import { ShieldCheck, Ban, Check, Trash2 } from "lucide-react";
import { fmtDate, ROLE_LABEL } from "@/lib/format";

const ROLE_TONE: Record<UserRole, string> = {
  rider: "",
  mechanic: "text-teal-600 dark:text-teal-400 border-teal-500/40",
  operator: "text-primary border-primary/40",
  admin: "text-amber-600 dark:text-amber-400 border-amber-500/40",
};

// Short, human description of what each role can do, surfaced as a tooltip on
// the role selector so staff understand the access a role grants before
// assigning it. Mirrors the server-side guards and client route gating.
const ROLE_HINT: Record<UserRole, string> = {
  rider: "Клиент: только клиентское приложение, без доступа к панели.",
  mechanic: "Механик: сервисные заявки и просмотр парка велосипедов. Остальные разделы скрыты.",
  operator: "Оператор: все разделы панели, кроме назначения роли администратора.",
  admin: "Администратор: полный доступ, включая управление ролями.",
};

export function UserRowItem({ u, isSelf, actorRole, onRole, onBlockToggle, onDeleteRequest, busy }: {
  u: User;
  isSelf: boolean;
  actorRole: UserRole | null;
  onRole: (role: UserRole) => void;
  onBlockToggle: () => void;
  onDeleteRequest?: () => void;
  busy: boolean;
}) {
  const role = (u.role as UserRole) ?? "rider";
  const blocked = !!u.blockedAt;
  // Match the server rule: only an admin may grant admin or touch an admin's
  // role. An admin can't demote themselves (would lock out the panel).
  const isAdminActor = actorRole === "admin";
  const roleSelectDisabled =
    busy ||
    (!isAdminActor && role === "admin") ||
    (isSelf && role === "admin");
  const roleOptions: UserRole[] = isAdminActor
    ? ["rider", "mechanic", "operator", "admin"]
    : ["rider", "mechanic", "operator"];
  // Operators can't block admins; nobody can block themselves.
  const blockDisabled = busy || isSelf || (role === "admin" && !isAdminActor);
  // Deletion is admin-only and irreversible: never offer it for the acting
  // admin's own row or for another admin (matches the server-side guard).
  const deleteDisabled = busy || isSelf || role === "admin";

  return (
    <TableRow data-testid={`user-row-${u.id}`} className={blocked ? "opacity-60" : ""}>
      <TableCell>
        <div className="font-medium">{u.name}</div>
        <div className="text-xs text-muted-foreground font-mono">{u.id.slice(0, 8)}</div>
      </TableCell>
      <TableCell>
        <div className="font-mono text-sm">{u.phone}</div>
        <div className="text-xs text-muted-foreground">{u.email ?? "—"}</div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={ROLE_TONE[role]} data-testid={`role-label-${u.id}`}>{ROLE_LABEL[role]}</Badge>
          <Select
            value={role}
            onValueChange={(v) => onRole(v as UserRole)}
            disabled={roleSelectDisabled}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <SelectTrigger className="h-8 w-[130px]" data-testid={`select-role-${u.id}`}>
                  <SelectValue />
                </SelectTrigger>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{ROLE_HINT[role]}</TooltipContent>
            </Tooltip>
            <SelectContent>
              {roleOptions.map((r) => (
                <SelectItem key={r} value={r} data-testid={`select-role-${u.id}-option-${r}`} title={ROLE_HINT[r]}>
                  {ROLE_LABEL[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </TableCell>
      <TableCell>
        {u.consentAcceptedAt ? (
          <div className="text-sm inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="w-3.5 h-3.5" />
            {fmtDate(u.consentAcceptedAt)}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">нет</span>
        )}
        {u.consentVersion && (
          <div className="text-xs text-muted-foreground">{u.consentVersion}</div>
        )}
      </TableCell>
      <TableCell className="text-sm">{fmtDate(u.createdAt)}</TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          {blocked ? (
            <Badge variant="outline" className="text-destructive border-destructive/40" data-testid={`status-${u.id}`}>
              Заблокирован
            </Badge>
          ) : (
            <Badge variant="outline" className="text-emerald-600 dark:text-emerald-400 border-emerald-500/40" data-testid={`status-${u.id}`}>
              Активен
            </Badge>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={blockDisabled}
            onClick={onBlockToggle}
            data-testid={`button-block-${u.id}`}
          >
            {blocked ? (
              <><Check className="w-3.5 h-3.5 mr-1" />Разблокировать</>
            ) : (
              <><Ban className="w-3.5 h-3.5 mr-1" />Заблокировать</>
            )}
          </Button>
        </div>
      </TableCell>
      {isAdminActor && (
        <TableCell>
          <Button
            size="sm"
            variant="outline"
            disabled={deleteDisabled}
            onClick={onDeleteRequest}
            className="text-destructive border-destructive/40 hover:bg-destructive/10"
            data-testid={`button-delete-${u.id}`}
          >
            <Trash2 className="w-3.5 h-3.5 mr-1" />Удалить
          </Button>
        </TableCell>
      )}
    </TableRow>
  );
}
