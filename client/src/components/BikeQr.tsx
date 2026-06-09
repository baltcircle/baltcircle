import { useMemo } from "react";
import { qrToSvg } from "@/lib/qrcode";

interface Props {
  // The payload to encode — typically the bike's public QR link.
  value: string;
  size?: number;
  className?: string;
  testId?: string;
}

// Renders a QR code for `value` as inline SVG. Generation is local (no network,
// no runtime dependency). Returns a small placeholder if the value can't be
// encoded (e.g. too long) so the UI never crashes.
export function BikeQr({ value, size = 200, className, testId }: Props) {
  const svg = useMemo(() => {
    try {
      return qrToSvg(value, { size });
    } catch {
      return null;
    }
  }, [value, size]);

  if (!svg) {
    return (
      <div
        className={className}
        data-testid={testId}
        style={{ width: size, height: size }}
      >
        <div className="flex h-full w-full items-center justify-center rounded-md bg-muted text-xs text-muted-foreground">
          QR недоступен
        </div>
      </div>
    );
  }

  return (
    <div
      className={className}
      data-testid={testId}
      // SVG is generated from our own deterministic encoder, not user HTML.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
