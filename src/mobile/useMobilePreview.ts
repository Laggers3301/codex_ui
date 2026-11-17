import { useEffect, useState } from "react";

/** Phone default. Desktop keeps its existing shell; no account/data migration. */
export function useMobilePreview() {
  const requested = new URLSearchParams(location.search).get("mobile-ui") !== "legacy";
  const [phone, setPhone] = useState(() => matchMedia("(max-width:720px)").matches);
  useEffect(() => {
    const media = matchMedia("(max-width:720px)");
    const changed = () => setPhone(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  return requested && phone;
}
