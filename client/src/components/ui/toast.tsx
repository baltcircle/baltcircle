import * as React from "react"
import * as ToastPrimitives from "@radix-ui/react-toast"
import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const ToastProvider = ToastPrimitives.Provider

const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Viewport>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Viewport
    ref={ref}
    className={cn(
      "fixed top-0 z-[100] flex max-h-screen w-full flex-col-reverse p-4 sm:bottom-0 sm:right-0 sm:top-auto sm:flex-col md:max-w-[420px]",
      className
    )}
    {...props}
  />
))
ToastViewport.displayName = ToastPrimitives.Viewport.displayName

const toastVariants = cva(
  "group pointer-events-auto relative flex w-full items-center justify-between space-x-4 overflow-hidden rounded-2xl p-4 pr-10 shadow-xl transition-all touch-pan-y data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[swipe=end]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-right-full data-[state=open]:slide-in-from-top-full data-[state=open]:sm:slide-in-from-bottom-full",
  {
    variants: {
      variant: {
        default: "bg-background text-foreground backdrop-blur-sm",
        destructive:
          "destructive group bg-destructive text-destructive-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

// Мульти-направленный swipe-to-dismiss: Radix Toast штатно умеет только одно направление.
// Навешиваем свой touch/pointer-обработчик: при swipe влево / вверх (в дополнение к native вправо)
// — анимируем уезд и дёргаем toast-close.
const SWIPE_THRESHOLD = 70;

function useMultiDirectionalSwipe() {
  const rootRef = React.useRef<HTMLLIElement | null>(null);
  const stateRef = React.useRef<{ x: number; y: number; active: boolean; dir: "none" | "x" | "y" }>({
    x: 0, y: 0, active: false, dir: "none",
  });

  const onPointerDown = (e: React.PointerEvent<HTMLLIElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    stateRef.current = { x: e.clientX, y: e.clientY, active: true, dir: "none" };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLLIElement>) => {
    const s = stateRef.current;
    if (!s.active) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;

    // Определяем доминирующую ось при первом значимом сдвиге. Radix уже ведёт горизонталь
    // (вправо) — мы вмешиваемся только для влево/вверх.
    if (s.dir === "none" && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      s.dir = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
    }

    const el = rootRef.current;
    if (!el) return;

    if (s.dir === "y" && dy < 0) {
      // Свайп вверх — тащим тоаст за пальцем, гасим опасть.
      el.style.transform = `translateY(${dy}px)`;
      el.style.opacity = String(Math.max(0, 1 + dy / 200));
    } else if (s.dir === "x" && dx < 0) {
      // Свайп влево (radix не обрабатывает) — аналогично.
      el.style.transform = `translateX(${dx}px)`;
      el.style.opacity = String(Math.max(0, 1 + dx / 200));
    }
    // Свайп вправо/вниз — отдаём Radix (он ведёт к native swipe-out).
  };

  const onPointerUp = (e: React.PointerEvent<HTMLLIElement>) => {
    const s = stateRef.current;
    if (!s.active) return;
    s.active = false;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    const el = rootRef.current;
    if (!el) return;

    const dismissLeft = s.dir === "x" && dx < -SWIPE_THRESHOLD;
    const dismissUp = s.dir === "y" && dy < -SWIPE_THRESHOLD;

    if (dismissLeft || dismissUp) {
      // Анимируем выезд, толкаем штатный close.
      el.style.transition = "transform 0.18s ease-out, opacity 0.18s ease-out";
      el.style.transform = dismissLeft ? "translateX(-120%)" : "translateY(-120%)";
      el.style.opacity = "0";
      const closeBtn = el.querySelector<HTMLButtonElement>("[toast-close]");
      window.setTimeout(() => closeBtn?.click(), 180);
    } else {
      // Не дотянул — возвращаем на место.
      el.style.transition = "transform 0.18s ease-out, opacity 0.18s ease-out";
      el.style.transform = "";
      el.style.opacity = "";
      window.setTimeout(() => {
        if (el) el.style.transition = "";
      }, 200);
    }
    stateRef.current.dir = "none";
  };

  return { rootRef, onPointerDown, onPointerMove, onPointerUp };
}

const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Root> &
    VariantProps<typeof toastVariants>
>(({ className, variant, ...props }, ref) => {
  const swipe = useMultiDirectionalSwipe();

  // Прокидываем ref — и внешний клиентский, и наш внутренний для swipe.
  const setRefs = (el: HTMLLIElement | null) => {
    swipe.rootRef.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) (ref as React.MutableRefObject<HTMLLIElement | null>).current = el;
  };

  return (
    <ToastPrimitives.Root
      ref={setRefs}
      className={cn(toastVariants({ variant }), className)}
      onPointerDown={swipe.onPointerDown}
      onPointerMove={swipe.onPointerMove}
      onPointerUp={swipe.onPointerUp}
      onPointerCancel={swipe.onPointerUp}
      {...props}
    />
  )
})
Toast.displayName = ToastPrimitives.Root.displayName

const ToastAction = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Action>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Action>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Action
    ref={ref}
    className={cn(
      "inline-flex h-8 shrink-0 items-center justify-center rounded-md border bg-transparent px-3 text-sm font-medium ring-offset-background transition-colors hover:bg-secondary focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 group-[.destructive]:border-muted/40 group-[.destructive]:hover:border-destructive/30 group-[.destructive]:hover:bg-destructive group-[.destructive]:hover:text-destructive-foreground group-[.destructive]:focus:ring-destructive",
      className
    )}
    {...props}
  />
))
ToastAction.displayName = ToastPrimitives.Action.displayName

const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Close
    ref={ref}
    className={cn(
      "absolute right-3 top-3 rounded-full p-1 text-foreground/60 opacity-100 transition-colors hover:text-foreground hover:bg-foreground/10 focus:outline-none focus:ring-2 group-[.destructive]:text-red-100 group-[.destructive]:hover:text-white group-[.destructive]:hover:bg-white/10 group-[.destructive]:focus:ring-red-400 group-[.destructive]:focus:ring-offset-red-600",
      className
    )}
    toast-close=""
    {...props}
  >
    <X className="h-4 w-4" />
  </ToastPrimitives.Close>
))
ToastClose.displayName = ToastPrimitives.Close.displayName

const ToastTitle = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Title
    ref={ref}
    className={cn("text-sm font-semibold", className)}
    {...props}
  />
))
ToastTitle.displayName = ToastPrimitives.Title.displayName

const ToastDescription = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Description
    ref={ref}
    className={cn("text-sm opacity-90", className)}
    {...props}
  />
))
ToastDescription.displayName = ToastPrimitives.Description.displayName

type ToastProps = React.ComponentPropsWithoutRef<typeof Toast>

type ToastActionElement = React.ReactElement<typeof ToastAction>

export {
  type ToastProps,
  type ToastActionElement,
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
  ToastAction,
}
