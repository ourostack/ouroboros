import type { SanctuaryHouse } from "../../senses/sanctuary-house"

// A fixed example household for tests that need public endpoints and required containers.
export const TEST_HOUSE: SanctuaryHouse = {
  ownerName: "Alex",
  butlerName: "Ouro Butler",
  householdName: "Example Home",
  publicEndpoints: [
    { name: "media", url: "https://media.example.home/" },
    { name: "books", url: "https://books.example.home/" },
    { name: "requests", url: "https://requests.example.home/" },
    { name: "readarr", url: "https://readarr.example.home/" },
  ],
  requiredContainers: ["calibre", "calibre-web", "Cloudflare-DDNS"],
  booksContainer: "calibre-web",
  jellyfinWebUrl: "https://media.example.home/",
}
