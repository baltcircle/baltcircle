import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { User, UserRole } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Search, Users, Ban, AlertTriangle } from "lucide-react";
import { TablePager, useClientPagination } from "@/components/table-pager";
import { UserRowItem } from "./users-admin/UserRow";
import { cleanErr } from "./users-admin/error-utils";

const USERS_KEY = ["/api/admin/users"];

export function UsersPage() {
  const toast = useToast();
  // The signed-in operator/admin — used to gate who may assign the admin role
  // (mirrors the server-side rule so the UI doesn't offer a forbidden action).
  const { role: actorRole, user: actor } = useCurrentUser();
  const usersQ = useQuery<User[]>({ queryKey: USERS_KEY });
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);

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

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/admin/users/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: USERS_KEY });
      toast.toast({ title: "Аккаунт удалён" });
      setDeleteTarget(null);
    },
    onError: (e: Error) => toast.toast({ title: "Не удалось удалить аккаунт", description: cleanErr(e), variant: "destructive" }),
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
  const { page, setPage, pageCount, pageItems } = useClientPagination(filtered);

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
                {actorRole === "admin" && <TableHead>Действия</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageItems.map((u) => (
                <UserRowItem
                  key={u.id}
                  u={u}
                  isSelf={actor?.id === u.id}
                  actorRole={actorRole}
                  onRole={(role) => roleMut.mutate({ id: u.id, role })}
                  onBlockToggle={() => blockMut.mutate({ id: u.id, blocked: !u.blockedAt })}
                  onDeleteRequest={() => setDeleteTarget(u)}
                  busy={roleMut.isPending || blockMut.isPending || (deleteMut.isPending && deleteTarget?.id === u.id)}
                />
              ))}
            </TableBody>
          </Table>
        )}
        <TablePager page={page} pageCount={pageCount} total={filtered.length} onPage={setPage} testid="users-pager" />
      </Card>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent data-testid="dialog-delete-user">
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить аккаунт «{deleteTarget?.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Это действие нельзя отменить. Мы отвяжем сохранённые карты и СБП, удалим данные профиля,
              обращения в поддержку и push-подписки. История поездок и платежей останется в обезличенном
              виде для учёта, а аккаунт исчезнет из этого списка.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMut.isPending}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMut.mutate(deleteTarget.id)}
              disabled={deleteMut.isPending}
              className="bg-destructive text-destructive-foreground border border-destructive-border hover:bg-destructive/90"
              data-testid="button-confirm-delete-user"
            >
              {deleteMut.isPending ? "Удаляем…" : "Удалить"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
