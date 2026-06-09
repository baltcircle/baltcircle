import { useCallback, useEffect, useRef, useState } from "react";
import type { Bike } from "@shared/schema";
import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QrCode, Bike as BikeIcon, Flashlight, FlashlightOff } from "lucide-react";

// Torch (flashlight) lives in non-standard MediaTrack types, so narrow locally.
type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean };
type TorchConstraintSet = MediaTrackConstraintSet & { torch?: boolean };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Available bikes used to resolve a scanned/typed code and to pick a test bike.
  bikes: Bike[];
  // Called once a bike has been scanned / chosen, to continue into rental.
  onBikeSelected: (bike: Bike) => void;
}

// Extract a bike code from raw QR text. Accepts a plain id ("BC-001") or a URL
// that carries the id in the path (".../#/bike/BC-001") or a query param
// (?bike=BC-001 / ?id=BC-001). Returns an upper-cased code or null.
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
  const [scanning, setScanning] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  // Guards against double-resolving a bike from rapid successive decodes.
  const handledRef = useRef(false);
  // True once a start has already been retried, so we retry at most once.
  const retriedRef = useRef(false);

  const availableBikes = bikes.filter((b) => b.status === "available");

  // The active video track carries both torch capability and constraints.
  const getVideoTrack = useCallback((): MediaStreamTrack | null => {
    const stream = videoRef.current?.srcObject as MediaStream | null;
    return stream?.getVideoTracks()[0] ?? null;
  }, []);

  const stopCamera = useCallback(() => {
    // Best-effort torch-off before releasing the track.
    const track = getVideoTrack();
    if (track && torchOn) {
      track
        .applyConstraints({ advanced: [{ torch: false } as TorchConstraintSet] })
        .catch(() => {});
    }
    controlsRef.current?.stop();
    controlsRef.current = null;
    const stream = videoRef.current?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setScanning(false);
    setTorchSupported(false);
    setTorchOn(false);
  }, [getVideoTrack, torchOn]);

  const toggleTorch = useCallback(async () => {
    const track = getVideoTrack();
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as TorchConstraintSet],
      });
      setTorchOn(next);
    } catch {
      setTorchSupported(false);
      setTorchOn(false);
    }
  }, [getVideoTrack, torchOn]);

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

  // Nudge the video element into actually rendering frames. zxing attaches the
  // stream and calls play(), but on a first open the element can stay blank
  // (white) until it's forced to play once metadata is in. Calling play() and
  // awaiting a real frame avoids the "stop then start" workaround users hit.
  const ensureVideoPlaying = useCallback(async (): Promise<boolean> => {
    const video = videoRef.current;
    if (!video) return false;
    try {
      await video.play();
    } catch {
      // Autoplay can reject transiently; the frame wait below is the real test.
    }
    if (video.readyState >= 2 && video.videoWidth > 0) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.removeEventListener("loadeddata", onReady);
        video.removeEventListener("canplay", onReady);
        resolve(ok);
      };
      const onReady = () => {
        video.play().catch(() => {});
        done(video.videoWidth > 0);
      };
      video.addEventListener("loadeddata", onReady);
      video.addEventListener("canplay", onReady);
      const timer = setTimeout(() => done(video.videoWidth > 0), 1500);
    });
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    setError(null);
    handledRef.current = false;

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setCameraError("Камера не поддерживается в этом браузере");
      return;
    }

    const reader = new BrowserQRCodeReader();
    try {
      setScanning(true);
      const controls = await reader.decodeFromConstraints(
        { video: { facingMode: { ideal: "environment" } } },
        videoRef.current!,
        (result) => {
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
        },
      );
      controlsRef.current = controls;

      const playing = await ensureVideoPlaying();
      // If no frame ever arrived, restart once — this mirrors the manual
      // stop/start that previously "fixed" the blank viewport.
      if (!playing && !retriedRef.current) {
        retriedRef.current = true;
        controlsRef.current?.stop();
        controlsRef.current = null;
        const stream = videoRef.current?.srcObject as MediaStream | null;
        stream?.getTracks().forEach((t) => t.stop());
        if (videoRef.current) videoRef.current.srcObject = null;
        await startCamera();
        return;
      }

      // Detect flashlight support on the active track.
      const track = getVideoTrack();
      const caps =
        (track?.getCapabilities?.() as TorchCapabilities | undefined) ?? undefined;
      setTorchSupported(Boolean(caps?.torch));
      setTorchOn(false);
    } catch (err) {
      setScanning(false);
      const name = (err as { name?: string })?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        setCameraError("Доступ к камере запрещён. Разрешите доступ или введите код вручную");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setCameraError("Камера не найдена");
      } else {
        setCameraError("Не удалось запустить камеру. Введите код вручную");
      }
    }
  }, [resolveCode, ensureVideoPlaying, getVideoTrack]);

  // Auto-start the camera when the modal opens; clean everything up on close.
  useEffect(() => {
    if (open) {
      setCode("");
      setError(null);
      setCameraError(null);
      retriedRef.current = false;
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
      <DialogContent data-testid="dialog-qr-scan">
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
          {!scanning && (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
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
          <div className="text-xs text-destructive text-center" data-testid="status-camera-error">
            {cameraError}
          </div>
        )}

        {scanning && (
          <div className="flex items-center justify-center gap-2">
            {torchSupported ? (
              <Button
                type="button"
                variant={torchOn ? "default" : "outline"}
                size="sm"
                onClick={toggleTorch}
                data-testid="button-toggle-torch"
              >
                {torchOn ? (
                  <FlashlightOff className="w-4 h-4 mr-2" />
                ) : (
                  <Flashlight className="w-4 h-4 mr-2" />
                )}
                Фонарик
              </Button>
            ) : (
              <span
                className="text-xs text-muted-foreground"
                data-testid="status-torch-unavailable"
              >
                Фонарик недоступен
              </span>
            )}
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
