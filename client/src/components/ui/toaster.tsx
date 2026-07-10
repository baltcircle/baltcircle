import { useToast } from "@/hooks/use-toast"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        return (
          <Toast key={id} {...props}>
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
            {action}
            {/* Крестик визуально скрыт, но в DOM остаётся — swipe-логика тоаста кликает по [toast-close] для dismiss. */}
            <ToastClose className="sr-only pointer-events-none" />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
