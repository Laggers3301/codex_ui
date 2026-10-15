type IconParkGlyph = (props: { theme?: "outline"; size?: number | string; fill?: string; strokeWidth?: number }) => string;

export default function WritingIcon({ glyph, size = 15, className = "" }: { glyph: IconParkGlyph; size?: number; className?: string }) {
  const svg = glyph({ theme: "outline", size, fill: "currentColor", strokeWidth: 3 }).replace(/^<\?xml[^>]*>/, "");
  return <span className={`writingIcon ${className}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}
