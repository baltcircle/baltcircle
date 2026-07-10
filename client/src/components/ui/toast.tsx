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

// Мы полностью взяли контроль над swipe/dismiss-анимацией (см. useToastSwipeDismiss),
// поэтому выключаем radix data-[swipe] транслейты и его встроенные slide-out
// (конфликтовали с нашим inline transform → кривая анимация).
const toastVariants = cva(
  "group pointer-events-auto relative flex w-full items-center justify-between space-x-4 overflow-hidden rounded-2xl p-4 shadow-xl touch-pan-y data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-full data-[state=open]:sm:slide-in-from-bottom-full",
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

// Swipe-to-dismiss во все четыре стороны (влево/вправо/вверх/вниз). Мы не доверяем
// встроенному Radix (он поддерживает только одно направление и его slide-out
// конфликтует с inline transform) — ведём всё сами: live-follow пальца + exit-анимация
// + клик по невидимому [toast-close] в конце.
const SWIPE_THRESHOLD = 60;
const EXIT_MS = 220;

function useToastSwipeDismiss() {
  const rootRef = React.useRef<HTMLLIElement | null>(null);
  const stateRef = React.useRef<{
    x: number; y: number; active: boolean; dir: "none" | "x" | "y";
    startedAt: number;
  }>({ x: 0, y: 0, active: false, dir: "none", startedAt: 0 });

  const onPointerDown = (e: React.PointerEvent<HTMLLIElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const el = rootRef.current;
    if (el) {
      // На время drag снимаем transitions — тоаст должен следовать за пальцем мгновенно.
      el.style.transition = "none";
    }
    stateRef.current = { x: e.clientX, y: e.clientY, active: true, dir: "none", startedAt: Date.now() };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLLIElement>) => {
    const s = stateRef.current;
    if (!s.active) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;

    if (s.dir === "none" && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
      s.dir = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
    }

    const el = rootRef.current;
    if (!el) return;

    if (s.dir === "x") {
      el.style.transform = `translate3d(${dx}px, 0, 0)`;
      el.style.opacity = String(Math.max(0, 1 - Math.abs(dx) / 240));
    } else if (s.dir === "y") {
      el.style.transform = `translate3d(0, ${dy}px, 0)`;
      el.style.opacity = String(Math.max(0, 1 - Math.abs(dy) / 240));
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLLIElement>) => {
    const s = stateRef.current;
    if (!s.active) return;
    s.active = false;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    const el = rootRef.current;
    if (!el) return;

    // Квалифицируем dismiss: либо дистанция превышена, либо velocity быстрая (flick).
    const dt = Math.max(1, Date.now() - s.startedAt);
    const vx = dx / dt; const vy = dy / dt;
    const isFlick = Math.abs(vx) > 0.5 || Math.abs(vy) > 0.5;

    let dismiss: null | "left" | "right" | "up" | "down" = null;
    if (s.dir === "x") {
      if (dx < -SWIPE_THRESHOLD || (isFlick && dx < 0)) dismiss = "left";
      else if (dx > SWIPE_THRESHOLD || (isFlick && dx > 0)) dismiss = "right";
    } else if (s.dir === "y") {
      if (dy < -SWIPE_THRESHOLD || (isFlick && dy < 0)) dismiss = "up";
      else if (dy > SWIPE_THRESHOLD || (isFlick && dy > 0)) dismiss = "down";
    }

    if (dismiss) {
      const outX = dismiss === "left" ? -window.innerWidth : dismiss === "right" ? window.innerWidth : 0;
      const outY = dismiss === "up" ? -300 : dismiss === "down" ? 300 : 0;
      el.style.transition = `transform ${EXIT_MS}ms cubic-bezier(0.32, 0.72, 0, 1), opacity ${EXIT_MS}ms ease-out`;
      el.style.transform = `translate3d(${outX}px, ${outY}px, 0)`;
      el.style.opacity = "0";
      const closeBtn = el.querySelector<HTMLButtonElement>("[toast-close]");
      window.setTimeout(() => closeBtn?.click(), EXIT_MS);
    } else {
      // Не дотянул — пружинисто возвращаем на место.
      el.style.transition = "transform 0.2s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.2s ease-out";
      el.style.transform = "translate3d(0, 0, 0)";
      el.style.opacity = "";
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
  const swipe = useToastSwipeDismiss();

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
