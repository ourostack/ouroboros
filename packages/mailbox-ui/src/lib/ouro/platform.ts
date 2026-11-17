export { detectPlatform };
export type { Platform };

/**
 * The platform family a shortcut's `mod` key follows: `apple` (⌘), `windows` and `other` (Ctrl), and
 * `unknown` before the page can tell, as on the server.
 * @claim "`unknown` before the page can tell, as on the server" registry/ouro/lib/ouro/use-platform.test.tsx verify:testExists(registry/ouro/lib/ouro/use-platform.test.tsx::usePlatform > renders unknown on the server, where the platform is not known)
 */
type Platform = "apple" | "windows" | "other" | "unknown";

/**
 * `apple` on macOS, iOS and iPadOS, `windows` on Windows (the only platform with a key
 * labeled Win), and `other` on Linux, ChromeOS and the rest, from the platform string of
 * the modern API when the browser has it.
 * @claim "`apple` on macOS, iOS and iPadOS" registry/ouro/lib/ouro/platform.test.ts verify:testExists(registry/ouro/lib/ouro/platform.test.ts::detectPlatform)
 * @claim "from the platform string of the modern API when the browser has it" registry/ouro/lib/ouro/platform.test.ts verify:testExists(registry/ouro/lib/ouro/platform.test.ts::detectPlatform)
 */
function detectPlatform(): Platform {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const name = nav.userAgentData?.platform ?? nav.platform;
  if (/mac|iphone|ipad|ipod|ios/i.test(name)) return "apple";
  return /^win/i.test(name) ? "windows" : "other";
}
