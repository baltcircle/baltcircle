import { CreditCard } from "lucide-react";

// Inline SVG logos for the payment systems we can detect from a card BIN
// (visa / mastercard / mir) plus the СБП (SBP) mark. Kept inline so they work
// offline and don't depend on an external CDN. Each renders inside a fixed
// 36×36 rounded tile to match the profile-row icon slot.

type Brand = "visa" | "mastercard" | "mir" | null | undefined;

// Wrapper tile matching the profile-row icon circle geometry (w-9 h-9).
function Tile({ children, bg }: { children: React.ReactNode; bg?: string }) {
  return (
    <span
      className={`flex items-center justify-center w-9 h-9 rounded-full shrink-0 overflow-hidden ${bg ?? "bg-muted"}`}
    >
      {children}
    </span>
  );
}

function VisaLogo() {
  return (
    <svg viewBox="0 0 48 16" className="w-7 h-4" role="img" aria-label="Visa">
      <path
        fill="#1A1F71"
        d="M20.6.3l-3 15h-3.7l3-15h3.7zM36 10l2-5.4.9 5.4H36zM40.6 15.3H44L41 .3h-3.1c-.7 0-1.3.4-1.5 1L30.5 15.3h3.7l.7-2h4.6l.4 2zM31 10.4c0-3.6-5-3.8-5-5.4 0-.5.5-1 1.5-1.1.5-.1 2-.1 3.6.6l.6-2.9c-.9-.3-2-.6-3.4-.6-3.6 0-6.1 1.9-6.1 4.6 0 2 1.8 3.1 3.2 3.8 1.4.7 1.9 1.1 1.9 1.7 0 .9-1.1 1.3-2.1 1.3-1.8 0-2.8-.5-3.6-.9l-.6 3c.8.4 2.3.7 3.9.7 3.8 0 6.3-1.9 6.3-4.8M15.5.3L9.8 15.3H6L3.2 4.4c-.2-.7-.3-.9-.8-1.2C1.5 2.7.2 2.3 0 2.2l.1-.4h6c.8 0 1.5.5 1.6 1.4l1.5 7.8L12.9.3h3.6z"
      />
    </svg>
  );
}

function MastercardLogo() {
  return (
    <svg viewBox="0 0 32 20" className="w-7 h-5" role="img" aria-label="Mastercard">
      <circle cx="12" cy="10" r="8" fill="#EB001B" />
      <circle cx="20" cy="10" r="8" fill="#F79E1B" />
      <path
        fill="#FF5F00"
        d="M16 3.5a8 8 0 010 13 8 8 0 010-13z"
      />
    </svg>
  );
}

function MirLogo() {
  // "МИР" wordmark as bold text — crisper and more legible at tile size than a
  // hand-traced path, in the brand's green.
  return (
    <svg viewBox="0 0 40 16" className="w-8 h-4" role="img" aria-label="Мир">
      <text
        x="20"
        y="13"
        textAnchor="middle"
        fontFamily="Arial, Helvetica, sans-serif"
        fontWeight="700"
        fontSize="14"
        letterSpacing="0.5"
        fill="#0F754E"
      >
        МИР
      </text>
    </svg>
  );
}

function SbpLogo() {
  // Stylised СБП (Fast Payments System) rainbow mark.
  return (
    <svg viewBox="0 0 24 24" className="w-6 h-6" role="img" aria-label="СБП">
      <path fill="#5B57A2" d="M3 6.5l3 1.7v7.6L3 14z" />
      <path fill="#D90751" d="M6 8.2l3.4-2 3 1.7-3.4 2z" />
      <path fill="#00A650" d="M6 15.8l3.4 2 3-1.7-3.4-2z" />
      <path fill="#F48120" d="M9.4 6.2L12 4.7l3 1.7-2.6 1.5z" />
      <path fill="#00AEEF" d="M9.4 17.8L12 19.3l3-1.7-2.6-1.5z" />
      <path fill="#654CA0" d="M12.4 8l3-1.7 3 1.7-3 1.7z" />
      <path fill="#00A650" d="M12.4 16l3 1.7 3-1.7-3-1.7z" />
      <path fill="#FED700" d="M15.4 9.7l3-1.7 2.6 1.5v4l-2.6 1.5-3-1.7z" />
    </svg>
  );
}

// Icon for a linked card, chosen by detected payment system. Falls back to the
// generic card glyph when the brand is unknown (e.g. legacy rows or a BIN we
// couldn't classify).
export function CardBrandIcon({ brand }: { brand?: Brand }) {
  switch (brand) {
    case "visa":
      return <Tile bg="bg-white dark:bg-zinc-100">{<VisaLogo />}</Tile>;
    case "mastercard":
      return <Tile bg="bg-white dark:bg-zinc-100">{<MastercardLogo />}</Tile>;
    case "mir":
      return <Tile bg="bg-white dark:bg-zinc-100">{<MirLogo />}</Tile>;
    default:
      return (
        <Tile>
          <CreditCard className="w-5 h-5 text-muted-foreground" />
        </Tile>
      );
  }
}

// Icon for the СБП method / action row.
export function SbpBrandIcon() {
  return <Tile bg="bg-white dark:bg-zinc-100">{<SbpLogo />}</Tile>;
}
