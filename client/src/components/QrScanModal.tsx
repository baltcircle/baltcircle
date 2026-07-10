import { useCallback, useEffect, useRef, useState } from "react";
import type { Bike } from "@shared/schema";
import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QrCode, Bike as BikeIcon, Loader2 } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Available bikes used to resolve a scanned/typed code and to pick a test bike.
  bikes: Bike[];
  // Called once a bike has been scanned / chosen, to continue into rental.
  onBikeSelected: (bike: Bike) => void;
}

// Extract a bike code from raw QR text. Accepts a plain id ("BC-001") or a URL
// that carries the id in the path — both the clean ".../bike/BC-001" and the
// legacy hash ".../#/bike/BC-001" forms — or a query param (?bike=BC-001 /
// ?id=BC-001). Returns an upper-cased code or null.
function extractBikeCode(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  const codePattern = /BC-?\d{1,5}/i;

  // Try to parse as a URL first (covers path + query param cases).
  try {
    const url = new URL(text);
    const fromQuery =
      url.searchParams.get("bike") ?? url.searchParams.get("id") ?? "";
    if (fromQuery) {
      const m = fromQuery.match(codePattern);
      if (m) return normalizeCode(m[0]);
    }
    // Path / hash may hold ".../bike/BC-001".
    const m = `${url.pathname}${url.hash}`.match(codePattern);
    if (m) return normalizeCode(m[0]);
  } catch {
    // Not a URL — fall through to plain matching.
  }

  const m = text.match(codePattern);
  if (m) return normalizeCode(m[0]);
  return null;
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

// Canonicalize to the "BC-001" shape the bike ids use.
function normalizeCode(raw: string): string {
  const upper = raw.toUpperCase().replace(/\s+/g, "");
  const digits = upper.replace(/^BC-?/, "");
  return `BC-${digits}`;
}

export function QrScanModal({ open, onOpenChange, bikes, onBikeSelected }: Props) {
  const [code, setCode] = useState("");
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

  const availableBikes = bikes.filter((b) => b.status === "available");

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

  const resolveCode = useCallback(
    (rawCode: string): boolean => {
      const normalized = rawCode.toUpperCase();
      const match = bikes.find((b) => b.id.toUpperCase() === normalized);
      if (!match) {
        setError("Велосипед с таким кодом не найден");
        return false;
      }
      if (match.status !== "available") {
        setError("Этот велосипед сейчас недоступен");
        return false;
      }
      stopCamera();
      onOpenChange(false);
      onBikeSelected(match);
      return true;
    },
    [bikes, onBikeSelected, onOpenChange, stopCamera],
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
        const bikeCode = extractBikeCode(result.getText());
        if (!bikeCode) {
          setError("Не удалось распознать код велосипеда");
          return;
        }
        handledRef.current = true;
        if (!resolveCode(bikeCode)) {
          // Allow another attempt if this code wasn't usable.
          handledRef.current = false;
        }
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
      setCode("");
      setError(null);
      setCameraError(null);
      startCamera();
    } else {
      stopCamera();
    }
    return () => stopCamera();
  }, [open, startCamera, stopCamera]);

  const confirmCode = () => {
    const raw = code.trim();
    if (!raw) {
      setError("Введите код велосипеда");
      return;
    }
    const bikeCode = extractBikeCode(raw) ?? raw.toUpperCase();
    resolveCode(bikeCode);
  };

  const useTestBike = () => {
    const bike = availableBikes[0];
    if (!bike) {
      setError("Нет доступных велосипедов для теста");
      return;
    }
    stopCamera();
    onOpenChange(false);
    onBikeSelected(bike);
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

        {/* Manual fallback: enter the code printed on the bike. */}
        <div className="space-y-2">
          <div className="text-sm font-medium">Не сканируется? Введите код вручную</div>
          <div className="flex items-center gap-2">
            <Input
              value={code}
              onChange={(e) => { setCode(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") confirmCode(); }}
              placeholder="Напр. BC-014"
              autoCapitalize="characters"
              data-testid="input-bike-code"
            />
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

        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={useTestBike}
          data-testid="button-use-test-bike"
        >
          <BikeIcon className="w-4 h-4 mr-2" /> Использовать тестовый велосипед
        </Button>
      </DialogContent>
    </Dialog>
  );
}
