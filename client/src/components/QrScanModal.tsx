import { useCallback, useEffect, useRef, useState } from "react";
import type { Bike } from "@shared/schema";
import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import { Button } from "@/components/ui/button";
import { X, Keyboard, Flashlight, CameraOff, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
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

// The torch (flashlight) constraint isn't in TS's standard MediaTrackCapabilities/
// MediaTrackConstraintSet typings — it's a real, widely-supported non-standard
// extension (Chrome/Android WebView), not something we're inventing.
interface TorchCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
}
interface TorchConstraintSet extends MediaTrackConstraintSet {
  torch?: boolean;
}

type ScanView = "scan" | "manual";

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
      <div className="text-[11px] leading-relaxed text-white/70 bg-white/10 rounded-lg p-3 text-left space-y-1.5">
        <div>
          Нажмите «Повторить» и в системном окне выберите{" "}
          <span className="font-medium text-white">«Разрешить»</span> (не «Один раз») —
          Safari запомнит выбор на 30 дней.
        </div>
        <div>
          Если уже отказали: Настройки iOS → Safari → Камера → Разрешить.
        </div>
      </div>
    );
  }

  return (
    <div className="text-[11px] leading-relaxed text-white/70 bg-white/10 rounded-lg p-3 text-left">
      Откройте настройки сайта (иконка замка в адресной строке)
      и разрешите доступ к камере для takeride.ru.
    </div>
  );
}

export function QrScanModal({
  open, onOpenChange, myActiveRideBikeIds, myReservationBikeIds, onBikeSelected,
}: Props) {
  // Which full-screen face this modal is showing right now: live camera scan
  // or manual code entry. The camera stream keeps running behind "manual" so
  // switching back is instant and the flashlight stays usable either way.
  const [view, setView] = useState<ScanView>("scan");

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

  // Torch (flashlight) support is per-device/per-track — only known once a
  // stream is acquired, so the button stays disabled until then.
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

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
    setTorchSupported(false);
    setTorchOn(false);
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

      const track = stream.getVideoTracks()[0];
      const capabilities = track?.getCapabilities?.() as TorchCapabilities | undefined;
      setTorchSupported(Boolean(capabilities?.torch));

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
      setView("scan");
      setDigits("");
      setError(null);
      setCameraError(null);
      startCamera();
    } else {
      stopCamera();
    }
    return () => stopCamera();
  }, [open, startCamera, stopCamera]);

  // Escape closes like any other full-screen overlay in the app; body scroll
  // is locked while open so the page behind it can't scroll on mobile.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onOpenChange]);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !torchSupported) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as TorchConstraintSet] });
      setTorchOn(next);
    } catch {
      // Device reported torch capability but rejected the constraint at
      // runtime (e.g. stream mid-teardown) — leave the toggle state as-is.
    }
  }, [torchOn, torchSupported]);

  const confirmCode = () => {
    const raw = digits.trim();
    if (!raw) {
      setError("Введите код велосипеда");
      return;
    }
    void resolveCode(`BC-${raw}`);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black overscroll-none"
      data-testid="dialog-qr-scan"
      role="dialog"
      aria-modal="true"
      aria-label={view === "scan" ? "Найдите QR-код на руле" : "Введите код"}
    >
      {/* Live camera feed, always mounted while open (even behind the manual
          screen) so the stream and flashlight keep working when switching
          views. */}
      <video
        ref={videoRef}
        className={cn(
          "absolute inset-0 w-full h-full object-cover",
          view !== "scan" && "opacity-0",
        )}
        muted
        autoPlay
        playsInline
        data-testid="video-qr-camera"
      />

      {/* Manual entry has no camera feed to show — solid backdrop over the
          hidden video. */}
      {view === "manual" && <div className="absolute inset-0 bg-neutral-900" />}

      {/* Scrim for text/button legibility over bright real-world footage. */}
      {view === "scan" && (
        <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-black/10 to-black/70 pointer-events-none" />
      )}

      {/* Header */}
      <div
        className="relative z-10 shrink-0 flex items-center justify-center px-14"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 1.25rem)", minHeight: "3.5rem" }}
      >
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="absolute left-4 flex items-center justify-center w-9 h-9 rounded-full text-white hover:bg-white/15 transition-colors"
          style={{ top: "calc(env(safe-area-inset-top) + 0.75rem)" }}
          data-testid="button-close-qr-scan"
        >
          <X className="w-6 h-6" />
        </button>
        <h1 className="text-white text-lg font-medium text-center">
          {view === "scan" ? "Найдите QR-код на руле" : "Введите код"}
        </h1>
      </div>

      {/* Scan view: full-screen camera behind a viewfinder frame. */}
      {view === "scan" && (
        <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-10">
          <div className="relative aspect-square w-full max-w-[280px]">
            <div className="absolute inset-0 rounded-3xl border-2 border-white/90" />
            {cameraState === "loading" && (
              <div
                className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white"
                data-testid="status-camera-loading"
              >
                <Loader2 className="w-8 h-8 animate-spin" />
                <span className="text-xs">Запуск камеры…</span>
              </div>
            )}
            {cameraState === "error" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-3xl bg-black/70 px-4 text-center">
                <CameraOff className="w-9 h-9 text-white/60" />
                <div className="text-xs text-white/90" data-testid="status-camera-error">
                  {cameraError}
                </div>
                {permissionDenied && <CameraPermissionHelp />}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={startCamera}
                  data-testid="button-retry-camera"
                  className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white"
                >
                  Повторить запуск камеры
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Manual view: BC-prefixed code entry, no decorative artwork or helper copy. */}
      {view === "manual" && (
        <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-8 gap-3">
          <div className="flex items-center w-full max-w-xs rounded-2xl border-2 border-white/80 bg-black overflow-hidden focus-within:border-primary">
            <span className="px-4 py-4 text-white/50 text-base font-mono select-none border-r border-white/20">
              BC-
            </span>
            <input
              value={digits}
              onChange={(e) => { setDigits(e.target.value.replace(/\D/g, "").slice(0, 5)); setError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") confirmCode(); }}
              placeholder="014"
              inputMode="numeric"
              autoFocus
              className="flex-1 min-w-0 px-3 py-4 text-base bg-transparent outline-none font-mono text-white placeholder:text-white/30"
              data-testid="input-bike-code"
            />
          </div>
          <Button
            type="button"
            onClick={confirmCode}
            className="w-full max-w-xs"
            data-testid="button-confirm-bike-code"
          >
            ОК
          </Button>
          {error && (
            <div className="text-xs text-red-400 text-center" data-testid="qr-scan-error">
              {error}
            </div>
          )}
        </div>
      )}

      {/* Bottom controls: switch to manual entry, toggle the flashlight. */}
      <div
        className="relative z-10 shrink-0 flex items-center justify-center gap-14"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 2rem)", paddingTop: "1rem" }}
      >
        <button
          type="button"
          onClick={() => setView((v) => (v === "scan" ? "manual" : "scan"))}
          className="flex items-center justify-center w-14 h-14 rounded-full bg-white/15 text-white hover:bg-white/25 transition-colors"
          data-testid="button-toggle-manual-entry"
        >
          <Keyboard className="w-6 h-6" />
        </button>
        <button
          type="button"
          onClick={toggleTorch}
          disabled={!torchSupported}
          className={cn(
            "flex items-center justify-center w-14 h-14 rounded-full transition-colors disabled:cursor-not-allowed",
            torchOn ? "bg-white text-black" : "bg-white/15 text-white hover:bg-white/25",
            !torchSupported && "opacity-40",
          )}
          data-testid="button-toggle-flashlight"
        >
          <Flashlight className="w-6 h-6" />
        </button>
      </div>
    </div>
  );
}
