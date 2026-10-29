import type { SanctuaryHouse } from "../../senses/sanctuary-house"

// A fixed example household for tests that need public endpoints and required containers.
export const TEST_HOUSE: SanctuaryHouse = {
  ownerName: "Ari",
  butlerName: "Mendelow Cloud Butler",
  householdName: "Mendelow Cloud",
  publicEndpoints: [
    { name: "media", url: "https://media.mendelow.cloud/" },
    { name: "books", url: "https://books.mendelow.cloud/" },
    { name: "requests", url: "https://requests.mendelow.cloud/" },
    { name: "readarr", url: "https://readarr.mendelow.cloud/" },
  ],
  requiredContainers: ["calibre", "calibre-web", "Cloudflare-DDNS"],
  booksContainer: "calibre-web",
  jellyfinWebUrl: "https://media.mendelow.cloud/",
}
