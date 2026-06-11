import { useState } from "react";
import { Link } from "wouter";
import { useCurrentUser } from "@/hooks/use-current-user";
import type { UserRole } from "@shared/schema";
import { RegistrationModal } from "@/components/RegistrationModal";
import { Button } from "@/components/ui/button";
import { ShieldAlert, LogIn, ArrowLeft } from "lucide-react";

// Gate for the operator/admin (`/admin/*`) area. States:
//  - loading: render nothing to avoid a flash of the denied screen
//  - not registered: show a clear access screen with a way to log in (the SMS
//    registration modal — an admin phone is promoted on verification)
//  - registered but not allowed for this section: show "Нет доступа"
// `roles` restricts a section to specific staff roles (e.g. mechanics may only
// reach service + fleet). Omitted = any staff role (operator/mechanic/admin).
export function AdminGuard({ children, roles }: { children: React.ReactNode; roles?: UserRole[] }) {
  const { isStaff, role, isRegistered, isLoading } = useCurrentUser();
  const [regOpen, setRegOpen] = useState(false);

  const allowed = isStaff && (!roles || (role != null && roles.includes(role)));

  if (isLoading) return null;
  if (allowed) return <>{children}</>;

  return (
    <div
      className="min-h-full flex items-center justify-center px-5 py-16"
      data-testid="page-admin-denied"
    >
      <RegistrationModal open={regOpen} onOpenChange={setRegOpen} />
      <div className="max-w-sm w-full text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <ShieldAlert className="h-7 w-7" />
        </div>
        <h1 className="font-display text-2xl font-light mb-2" data-testid="text-admin-denied-title">
          Нет доступа
        </h1>
        {isRegistered ? (
          <p className="text-sm text-muted-foreground mb-6" data-testid="text-admin-denied-message">
            Операторская панель доступна только сотрудникам. Если вам нужен
            доступ, обратитесь к администратору.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground mb-6" data-testid="text-admin-denied-message">
            Войдите учётной записью оператора, чтобы открыть панель управления.
          </p>
        )}
        <div className="flex flex-col gap-2">
          {!isRegistered && (
            <Button onClick={() => setRegOpen(true)} data-testid="button-admin-login">
              <LogIn className="w-4 h-4 mr-2" /> Войти
            </Button>
          )}
          <Link href="/" data-testid="link-admin-denied-home">
            <Button variant="outline" className="w-full">
              <ArrowLeft className="w-4 h-4 mr-2" /> На главную
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
