import { useCallback, useEffect, useRef, useState } from "react";
import type { Bike } from "@shared/schema";
import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { QrCode, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { extractBikeCode, classifyBikeForScan } from "./qr-scan-utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // This rider's own in-progress rental/reservation, if any — lets a scan of
  // THEIR OWN rented/reserved bike still resolve, while anyone else scanning
  // it gets the spec'd "занят" message (bike-status lifecycle audit).
  myActiveRideBikeIds?: string[];
  myReservationBikeIds?: string[];
  // Called once a bike has been scanned / chosen, to continue into rental.
  onBikeSelected: (bike: Bike) => void;
}

// Простая детекция iOS: любой браузер на iOS использует WebKit и ведёт себя одинаково.
function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !("MSStream" in window);
}

// Подсказка при permission=denied.
// Важно: iOS Safari в обычной вкладке разрешение камеры спрашивает
// каждую сессию (при перезагрузке, закрытии вкладки). Это ограничение WebKit —
// его нельзя обойти кодом или привязать разрешение к аккаунту на сервере:
// браузер всё равно спросит у пользователя, прежде чем выдать MediaStream.
function CameraPermissionHelp() {
  if (isIOS()) {
    return (
      <div className="text-[11px] leading-relaxed text-muted-foreground bg-muted/40 rounded-lg p-3 text-left space-y-1.5">
        <div>
          Нажмите «Повторить» и в системном окне выберите{" "}
          <span className="font-medium text-foreground">«Разрешить»</span> (не «Один раз») —
          Safari запомнит выбор на 30 дней.
        </div>
        <div>
          Если уже отказали: Настройки iOS → Safari → Камера → Разрешить.
        </div>
      </div>
    );
  }

  return (
    <div className="text-[11px] leading-relaxed text-muted-foreground bg-muted/40 rounded-lg p-3 text-left">
      Откройте настройки сайта (иконка замка в адресной строке)
      и разрешите доступ к камере для takeride.ru.
    </div>
  );
}

export function QrScanModal({
  open, onOpenChange, myActiveRideBikeIds, myReservationBikeIds, onBikeSelected,
}: Props) {
  // Manual entry only ever needs the digits — the "BC-" prefix is fixed and
  // shown as a non-editable adornment (same pattern as the +7 phone prefix in
  // AuthModal), so a rider can't mistype or omit it.
  const [digits, setDigits] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  // Когда браузер вернул NotAllowedError — показываем более полезную
  // подсказку со ссылкой на регулярное разрешение и (на iOS) в PWA.
  const [permissionDenied, setPermissionDenied] = useState(false);
  // "loading" while acquiring the camera / waiting for the first frame,
  // "scanning" once frames are flowing, "error" when start failed.
  const [cameraState, setCameraState] = useState<"loading" | "scanning" | "error">("loading");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  // Guards against double-resolving a bike from rapid successive decodes.
  const handledRef = useRef(false);

  const stopCamera = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const video = videoRef.current;
    if (video) {
      video.srcObject = null;
    }
  }, []);

  // Extracts a "BC-XXX" code locally (camera decode, manual entry, or a URL)
  // then resolves it against the server's unfiltered /api/bikes/:id — NOT
  // the rider-filtered /api/bikes list — so a scan can always tell a real
  // out-of-rotation/other-rider bike apart from a nonexistent code, and
  // return the exact spec'd per-status message either way.
  const resolveCode = useCallback(
    async (raw: string): Promise<boolean> => {
      const code = extractBikeCode(raw);
      if (!code) {
        setError("Велосипед с таким кодом не найден");
        return false;
      }
      let bike: Bike;
      try {
        const res = await apiRequest("GET", `/api/bikes/${code}`);
        bike = await res.json();
      } catch {
        setError("Велосипед с таким кодом не найден");
        return false;
      }
      const result = classifyBikeForScan(bike, {
        myActiveRideBikeIds, myReservationBikeIds,
      });
      if ("error" in result) {
        setError(result.error);
        return false;
      }
      stopCamera();
      onOpenChange(false);
      onBikeSelected(result.bike);
      return true;
    },
    [myActiveRideBikeIds, myReservationBikeIds, onBikeSelected, onOpenChange, stopCamera],
  );

  // Wait until the video element is actually decoding frames. The blank/white
  // viewport on a first open comes from handing the element to the decoder
  // before it has painted a frame, so we own the stream: attach it, play it,
  // and only resolve once metadata is in and a real frame size is reported.
  const waitForFirstFrame = useCallback(
    (video: HTMLVideoElement): Promise<boolean> => {
      const hasFrame = () => video.readyState >= 2 && video.videoWidth > 0;
      if (hasFrame()) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          video.removeEventListener("loadedmetadata", onReady);
          video.removeEventListener("loadeddata", onReady);
          video.removeEventListener("playing", onReady);
          resolve(ok);
        };
        const onReady = () => {
          video.play().catch(() => {});
          if (hasFrame()) finish(true);
        };
        video.addEventListener("loadedmetadata", onReady);
        video.addEventListener("loadeddata", onReady);
        video.addEventListener("playing", onReady);
        const timer = setTimeout(() => finish(hasFrame()), 6000);
      });
    },
    [],
  );

  const startCamera = useCallback(async () => {
    setCameraError(null);
    setError(null);
    setPermissionDenied(false);
    setCameraState("loading");
    handledRef.current = false;

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setCameraState("error");
      setCameraError("Камера не поддерживается в этом браузере");
      return;
    }

    // Проверяем текущее состояние разрешения через Permissions API.
    // Если браузер уже знает, что denied, — не вызываем getUserMedia впустую
    // (браузер всё равно вернёт ошибку), сразу показываем подсказку и ручной ввод.
    // Safari до 16 не поддерживает permissions.query({name:"camera"}) — ловим тихо.
    try {
      const status = await (navigator.permissions as Permissions | undefined)?.query({
        name: "camera" as PermissionName,
      });
      if (status?.state === "denied") {
        setCameraState("error");
        setPermissionDenied(true);
        setCameraError("Доступ к камере запрещён");
        return;
      }
    } catch {
      // Permissions API недоступен — продолжаем обычным путём.
    }

    // Tear down any prior attempt before acquiring a fresh stream.
    stopCamera();

    try {
      // Own the stream ourselves so we control attach/play/first-frame timing.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        return;
      }

      video.srcObject = stream;
      video.muted = true;
      video.setAttribute("playsinline", "true");
      try {
        await video.play();
      } catch {
        // Some browsers reject the first play(); the frame wait is the real test.
      }

      const ready = await waitForFirstFrame(video);
      if (!ready) {
        stopCamera();
        setCameraState("error");
        setCameraError("Камера не выводит изображение. Повторите запуск или введите код вручную");
        return;
      }

      setCameraState("scanning");

      // Hand the already-playing element to the decoder. It reads frames from
      // the element we set up, so it never re-attaches or resets the stream.
      const reader = new BrowserQRCodeReader();
      controlsRef.current = await reader.decodeFromVideoElement(video, (result) => {
        if (!result || handledRef.current) return;
        handledRef.current = true;
        void resolveCode(result.getText()).then((ok) => {
          // Allow another attempt if this code wasn't usable.
          if (!ok) handledRef.current = false;
        });
      });
    } catch (err) {
      stopCamera();
      setCameraState("error");
      const name = (err as { name?: string })?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        setPermissionDenied(true);
        setCameraError("Доступ к камере запрещён");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setCameraError("Камера не найдена");
      } else {
        setCameraError("Не удалось запустить камеру. Введите код вручную");
      }
    }
  }, [resolveCode, stopCamera, waitForFirstFrame]);

  // Auto-start the camera when the modal opens; clean everything up on close.
  useEffect(() => {
    if (open) {
      setDigits("");
      setError(null);
      setCameraError(null);
      startCamera();
    } else {
      stopCamera();
    }
    return () => stopCamera();
  }, [open, startCamera, stopCamera]);

  const confirmCode = () => {
    const raw = digits.trim();
    if (!raw) {
      setError("Введите код велосипеда");
      return;
    }
    void resolveCode(`BC-${raw}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="dialog-qr-scan"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="font-display font-light flex items-center gap-2">
            <QrCode className="w-5 h-5" /> Сканирование QR
          </DialogTitle>
          <DialogDescription>
            Наведите камеру на QR-код велосипеда
          </DialogDescription>
        </DialogHeader>

        {/* Live camera viewport with scanner framing. */}
        <div className="relative aspect-square w-full max-w-[240px] mx-auto rounded-2xl border border-card-border bg-muted/40 overflow-hidden">
          <video
            ref={videoRef}
            className="absolute inset-0 w-full h-full object-cover"
            muted
            autoPlay
            playsInline
            data-testid="video-qr-camera"
          />
          {cameraState === "loading" && (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted/60 text-muted-foreground"
              data-testid="status-camera-loading"
            >
              <Loader2 className="w-8 h-8 animate-spin" />
              <span className="text-xs">Запуск камеры…</span>
            </div>
          )}
          {cameraState === "error" && (
            <div className="absolute inset-0 flex items-center justify-center bg-muted/60 text-muted-foreground">
              <QrCode className="w-16 h-16 opacity-40" />
            </div>
          )}
          {/* Corner brackets for a familiar scanner feel. */}
          <div className="absolute inset-5 pointer-events-none">
            <span className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-primary rounded-tl-md" />
            <span className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-primary rounded-tr-md" />
            <span className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-primary rounded-bl-md" />
            <span className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-primary rounded-br-md" />
          </div>
        </div>

        {cameraError && (
          <div className="space-y-2 text-center">
            <div className="text-xs text-destructive" data-testid="status-camera-error">
              {cameraError}
            </div>
            {permissionDenied && <CameraPermissionHelp />}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={startCamera}
              data-testid="button-retry-camera"
            >
              Повторить запуск камеры
            </Button>
          </div>
        )}

        {/* Manual fallback: enter the code printed on the bike. "BC-" is fixed
            so the rider only ever types the digits from the sticker. */}
        <div className="space-y-2">
          <div className="text-sm font-medium">Не сканируется? Введите код вручную</div>
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center border rounded-md overflow-hidden focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-0">
              <span className="px-3 py-2 bg-muted text-muted-foreground text-sm font-mono select-none border-r">BC-</span>
              <input
                value={digits}
                onChange={(e) => { setDigits(e.target.value.replace(/\D/g, "").slice(0, 5)); setError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") confirmCode(); }}
                placeholder="014"
                inputMode="numeric"
                className="flex-1 min-w-0 px-3 py-2 text-sm bg-background outline-none font-mono"
                data-testid="input-bike-code"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={confirmCode}
              data-testid="button-confirm-bike-code"
            >
              ОК
            </Button>
          </div>
          {error && (
            <div className="text-xs text-destructive" data-testid="qr-scan-error">{error}</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
