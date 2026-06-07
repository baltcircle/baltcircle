import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { User, UserRole } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Search, Users, ShieldCheck, Ban, Check, AlertTriangle } from "lucide-react";
import { fmtDate } from "@/lib/format";

const USERS_KEY = ["/api/admin/users"];

const ROLE_LABEL: Record<UserRole, string> = {
  rider: "Райдер",
  operator: "Оператор",
  admin: "Администратор",
};
const ROLE_TONE: Record<UserRole, string> = {
  rider: "",
  operator: "text-primary border-primary/40",
  admin: "text-amber-600 dark:text-amber-400 border-amber-500/40",
};

export function UsersPage() {
  const toast = useToast();
  // The signed-in operator/admin — used to gate who may assign the admin role
  // (mirrors the server-side rule so the UI doesn't offer a forbidden action).
  const { role: actorRole, user: actor } = useCurrentUser();
  const usersQ = useQuery<User[]>({ queryKey: USERS_KEY });
  const [search, setSearch] = useState("");

  const roleMut = useMutation({
    mutationFn: async (p: { id: string; role: UserRole }) => {
      const res = await apiRequest("PATCH", `/api/admin/users/${p.id}/role`, { role: p.role });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: USERS_KEY });
      toast.toast({ title: "Роль обновлена" });
    },
    onError: (e: Error) => toast.toast({ title: "Не удалось изменить роль", description: cleanErr(e), variant: "destructive" }),
  });

  const blockMut = useMutation({
    mutationFn: async (p: { id: string; blocked: boolean }) => {
      const res = await apiRequest("PATCH", `/api/admin/users/${p.id}/status`, { blocked: p.blocked });
      return res.json();
    },
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: USERS_KEY });
      toast.toast({ title: vars.blocked ? "Аккаунт заблокирован" : "Аккаунт разблокирован" });
    },
    onError: (e: Error) => toast.toast({ title: "Не удалось изменить статус", description: cleanErr(e), variant: "destructive" }),
  });

  const users = usersQ.data ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      u.name.toLowerCase().includes(q) ||
      u.phone.toLowerCase().includes(q) ||
      (u.email ?? "").toLowerCase().includes(q),
    );
  }, [users, search]);

  const blockedCount = users.filter((u) => u.blockedAt).length;

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-7xl mx-auto" data-testid="page-users">
      <header className="mb-6 flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Доступ</div>
          <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">Пользователи</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Зарегистрированные райдеры, их роли, согласие на обработку данных и статус доступа.
          </p>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Имя, телефон или email"
            className="pl-9 w-64"
            data-testid="input-users-search"
          />
        </div>
      </header>

      <div className="flex items-center gap-2 mb-4 text-sm text-muted-foreground" data-testid="users-summary">
        <span className="inline-flex items-center gap-1.5"><Users className="w-4 h-4" /> Всего: {users.length}</span>
        {blockedCount > 0 && (
          <span className="inline-flex items-center gap-1.5 text-destructive">
            <Ban className="w-4 h-4" /> заблокировано: {blockedCount}
          </span>
        )}
      </div>

      <Card className="overflow-hidden">
        {usersQ.isLoading ? (
          <div className="p-10 text-center text-sm text-muted-foreground" data-testid="users-loading">
            Загрузка пользователей…
          </div>
        ) : usersQ.isError ? (
          <div className="p-10 text-center" data-testid="users-error">
            <AlertTriangle className="w-6 h-6 mx-auto mb-2 text-destructive" />
            <div className="text-sm text-muted-foreground mb-3">Не удалось загрузить список пользователей.</div>
            <Button variant="outline" size="sm" onClick={() => usersQ.refetch()} data-testid="button-users-retry">
              Повторить
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground" data-testid="users-empty">
            {users.length === 0 ? "Пока нет зарегистрированных пользователей." : "Никто не найден по запросу."}
          </div>
        ) : (
          <Table data-testid="users-table">
            <TableHeader>
              <TableRow>
                <TableHead>Пользователь</TableHead>
                <TableHead>Контакты</TableHead>
                <TableHead>Роль</TableHead>
                <TableHead>Согласие</TableHead>
                <TableHead>Регистрация</TableHead>
                <TableHead>Статус</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((u) => (
                <UserRowItem
                  key={u.id}
                  u={u}
                  isSelf={actor?.id === u.id}
                  actorRole={actorRole}
                  onRole={(role) => roleMut.mutate({ id: u.id, role })}
                  onBlockToggle={() => blockMut.mutate({ id: u.id, blocked: !u.blockedAt })}
                  busy={roleMut.isPending || blockMut.isPending}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function UserRowItem({ u, isSelf, actorRole, onRole, onBlockToggle, busy }: {
  u: User;
  isSelf: boolean;
  actorRole: UserRole | null;
  onRole: (role: UserRole) => void;
  onBlockToggle: () => void;
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
  const roleOptions: UserRole[] = isAdminActor ? ["rider", "operator", "admin"] : ["rider", "operator"];
  // Operators can't block admins; nobody can block themselves.
  const blockDisabled = busy || isSelf || (role === "admin" && !isAdminActor);

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
          <Badge variant="outline" className={ROLE_TONE[role]}>{ROLE_LABEL[role]}</Badge>
          <Select
            value={role}
            onValueChange={(v) => onRole(v as UserRole)}
            disabled={roleSelectDisabled}
          >
            <SelectTrigger className="h-8 w-[130px]" data-testid={`select-role-${u.id}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roleOptions.map((r) => (
                <SelectItem key={r} value={r}>{ROLE_LABEL[r]}</SelectItem>
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
    </TableRow>
  );
}

// apiRequest throws "<status>: <body>" — pull a human message out of the body.
function cleanErr(e: Error): string {
  const m = e.message.match(/^\d+:\s*([\s\S]*)$/);
  const body = m ? m[1] : e.message;
  try {
    const parsed = JSON.parse(body);
    if (parsed?.error) return parsed.error;
  } catch {
    // body wasn't JSON; fall through
  }
  return body;
}
