/** Resolve an authored relative asset path against the child thread cwd. */
export function resolveRelativeAssetTarget(basePath: string | undefined, target: string): string | null {
  if (!basePath || !basePath.startsWith("/") || target.startsWith("/") || /^file:\/\//i.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const suffixIndex = target.search(/[?#]/);
  const pathPart = suffixIndex < 0 ? target : target.slice(0, suffixIndex);
  const suffix = suffixIndex < 0 ? "" : target.slice(suffixIndex);
  const segments = basePath.split("/").filter(Boolean);
  const baseLength = segments.length;
  for (const segment of pathPart.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length <= baseLength) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}${suffix}`;
}

export function extractImageTargetsFromText(text: string, allowRelative = false): string[] {
  const pattern = allowRelative
    ? /(?:^|[\s([{<\x22\x27\x60=：:])((?:file:\/\/[^\s)\]\x22\x27\x60<>]+|\/(?!\/)[^\s)\]\x22\x27\x60<>]+\.(?:png|jpe?g|gif|webp|svg)(?:[#?][^\s)\]\x22\x27\x60<>]*)?|(?:\.{1,2}\/)?[\p{L}\p{N}_][\p{L}\p{N}_.()-]*(?:\/[\p{L}\p{N}_][\p{L}\p{N}_.()-]*)*\.(?:png|jpe?g|gif|webp|svg)(?:[#?][^\s)\]\x22\x27\x60<>]*)?))(?=$|[\s)\]}>\x22\x27\x60，。；）])/giu
    : /(?:^|[\s([{<\x22\x27\x60=：:])((?:file:\/\/[^\s)\]\x22\x27\x60<>]+|\/(?!\/)[^\s)\]\x22\x27\x60<>]+\.(?:png|jpe?g|gif|webp|svg)(?:[#?][^\s)\]\x22\x27\x60<>]*)?))(?=$|[\s)\]}>\x22\x27\x60，。；）])/giu;
  const found = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const target = match[1]?.replace(/[.,;!?，。；！？]+$/, "");
    if (target) found.add(target);
  }
  return Array.from(found).slice(0, 12);
}
