// GERADO por scripts/gen-sources.ts a partir de sources/*.yaml — não edite à mão.
// Rode `pnpm --filter @actually/kb-ingest gen:sources` depois de mudar os YAML.

export const APIFY_MANIFEST_RAW: unknown = {
  "crawl": {
    "actor": "apify/website-content-crawler",
    "input": {
      "startUrls": "$START_URLS",
      "maxCrawlPages": "$MAX_PAGES"
    },
    "jobs": [
      {
        "name": "lupa",
        "kind": "factcheck",
        "start_urls": [
          "https://lupa.uol.com.br/"
        ],
        "max_pages": 150
      },
      {
        "name": "aos-fatos",
        "kind": "factcheck",
        "start_urls": [
          "https://aosfatos.org/"
        ],
        "max_pages": 150
      },
      {
        "name": "estadao-verifica",
        "kind": "factcheck",
        "start_urls": [
          "https://estadao.com.br/estadao-verifica/"
        ],
        "max_pages": 150
      },
      {
        "name": "fato-ou-fake",
        "kind": "factcheck",
        "start_urls": [
          "https://g1.globo.com/fato-ou-fake/"
        ],
        "max_pages": 150
      },
      {
        "name": "comprova",
        "kind": "factcheck",
        "start_urls": [
          "https://projetocomprova.com.br/"
        ],
        "max_pages": 150
      },
      {
        "name": "uol-confere",
        "kind": "factcheck",
        "start_urls": [
          "https://noticias.uol.com.br/confere/"
        ],
        "max_pages": 150
      },
      {
        "name": "afp-checamos",
        "kind": "factcheck",
        "start_urls": [
          "https://checamos.afp.com/"
        ],
        "max_pages": 150
      }
    ]
  },
  "youtube": {
    "actor": "curious_coder/youtube-transcript-scraper",
    "videos": []
  },
  "search": {
    "actor": "apify/google-search-scraper",
    "input": {
      "queries": "$QUERIES_NEWLINE"
    }
  }
};

export const FEEDS_RAW: unknown = {
  "feeds": []
};
