import type { Bike } from "@shared/schema";
import { bikeQrLink } from "@/lib/format";
import { qrToSvg } from "@/lib/qrcode";
import { BikeQr } from "@/components/BikeQr";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Copy, Download, Printer, QrCode } from "lucide-react";
import { escapeHtml } from "./bike-utils";

export function BikeQrDialog({
  bike, onClose, onCopied,
}: { bike: Bike | null; onClose: () => void; onCopied: () => void }) {
  const link = bike ? bikeQrLink(bike.id) : "";

  const download = () => {
    if (!bike) return;
    // Bake the bike code into the downloaded file itself — it may be handed
    // off to a printer/label service that never sees this dialog's on-screen
    // text, so the code has to travel inside the SVG.
    const svg = qrToSvg(link, { size: 512, label: bike.id });
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `qr-${bike.id}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const print = () => {
    if (!bike) return;
    const svg = qrToSvg(link, { size: 320 });
    const w = window.open("", "_blank", "width=420,height=560");
    if (!w) return;
    // bike.id / bike.model are operator-controlled free text — escape before
    // interpolating into the print document so they can't inject markup (M10).
    const id = escapeHtml(bike.id);
    const model = escapeHtml(bike.model);
    w.document.write(`<!doctype html><html><head><title>QR ${id}</title>
      <style>body{font-family:sans-serif;text-align:center;padding:32px}
      h1{font-size:20px;margin:16px 0 4px}p{color:#666;margin:0;font-size:13px}</style>
      </head><body>${svg}<h1>${id}</h1><p>${model}</p>
      <script>window.onload=function(){window.print();}</script></body></html>`);
    w.document.close();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      onCopied();
    } catch {
      /* clipboard unavailable — link is still visible to copy manually */
    }
  };

  return (
    <Dialog open={!!bike} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="dialog-bike-qr">
        <DialogHeader>
          <DialogTitle className="font-display font-light flex items-center gap-2">
            <QrCode className="w-5 h-5" /> QR-код {bike?.id}
          </DialogTitle>
          <DialogDescription>Распечатайте и наклейте на велосипед.</DialogDescription>
        </DialogHeader>

        {bike && (
          <div className="flex flex-col items-center gap-4">
            <BikeQr value={link} label={bike.id} size={220} className="rounded-lg border border-card-border p-2 bg-white" testId="bike-qr-image" />
            <code className="text-xs break-all text-center text-muted-foreground" data-testid="bike-qr-link">{link}</code>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="outline" size="sm" onClick={copy} data-testid="button-copy-qr">
                <Copy className="w-4 h-4 mr-2" /> Копировать
              </Button>
              <Button variant="outline" size="sm" onClick={download} data-testid="button-download-qr">
                <Download className="w-4 h-4 mr-2" /> Скачать QR
              </Button>
              <Button variant="outline" size="sm" onClick={print} data-testid="button-print-qr">
                <Printer className="w-4 h-4 mr-2" /> Печать QR
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
